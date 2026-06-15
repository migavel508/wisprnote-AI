import { Turbopuffer } from '@turbopuffer/turbopuffer';
import { aiProxyFetch } from './aiProxyService';
import { logger } from '../lib/logger';
import {
  getTurbopufferIndexedSet,
  markTurbopufferIndexed,
  isTurbopufferIndexed,
  clearTurbopufferLedgerState,
} from './awsLedgerService';

const log = logger.scope('Turbopuffer');

const NAMESPACE = 'lumina-meetings';
const RRF_K = 60;

let _client: Turbopuffer | null = null;

function getClient(): Turbopuffer {
  if (!_client) {
    // The real Turbopuffer key lives server-side. aiProxyFetch reroutes every
    // *.turbopuffer.com request through our authed Lambda proxy, which injects
    // the key — so the placeholder key below is never sent to Turbopuffer.
    _client = new Turbopuffer({
      apiKey: 'proxied-via-lambda',
      region: 'gcp-us-central1',
      fetch: aiProxyFetch,
    });
  }
  return _client;
}

function getNamespace() {
  return getClient().namespace(NAMESPACE);
}

export function isTurbopufferConfigured(): boolean {
  // Always available now — auth is handled server-side by the proxy.
  return true;
}

// ─── Indexing ────────────────────────────────────────────────────────────────

export interface ChunkForIndexing {
  chunkIndex: number;
  text: string;
  speakers: string[];
  vector: number[];
}

export interface ChunkMeta {
  /** Meeting date (ISO) → stored as epoch ms for vector-layer date filtering. */
  createdAt?: string;
  /** Attendee names → enables person filtering at the vector layer. */
  attendees?: string[];
  /** Owning workspace (for workspace-scoped vector queries). */
  workspaceId?: string;
}

export async function upsertMeetingChunks(
  meetingId: string,
  meetingTitle: string,
  chunks: ChunkForIndexing[],
  meta?: ChunkMeta,
): Promise<void> {
  if (!chunks.length) return;
  const ns = getNamespace();

  try {
    await ns.write({
      delete_by_filter: ['meeting_id', 'Eq', meetingId],
    });
  } catch {
    // namespace may not exist yet
  }

  const createdMs = meta?.createdAt ? new Date(meta.createdAt).getTime() : undefined;
  const attendeesStr = meta?.attendees?.length ? meta.attendees.join(', ') : undefined;

  // Each upserted row carries its full embedding vector (~3072 dims → tens of KB
  // of JSON). Turbopuffer writes are proxied through the authed Lambda, which has
  // a ~6 MB payload limit — 100 rows/batch produced multi-MB writes that hit
  // "413 Request Too Long". 16 rows/batch keeps each write well under the limit.
  const BATCH_SIZE = 16;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    await ns.write({
      upsert_rows: batch.map((chunk) => ({
        id: `${meetingId}:${chunk.chunkIndex}`,
        vector: chunk.vector,
        text: chunk.text,
        meeting_id: meetingId,
        meeting_title: meetingTitle,
        speakers: chunk.speakers.join(', '),
        chunk_index: chunk.chunkIndex,
        ...(createdMs !== undefined ? { created_ms: createdMs } : {}),
        ...(attendeesStr ? { attendees: attendeesStr } : {}),
        ...(meta?.workspaceId ? { workspace_id: meta.workspaceId } : {}),
      })),
      distance_metric: 'cosine_distance',
      schema: {
        text: { type: 'string' as const, full_text_search: true },
        meeting_id: { type: 'string' as const },
        meeting_title: { type: 'string' as const, filterable: false },
        speakers: { type: 'string' as const, filterable: false },
        chunk_index: { type: 'int' as const },
        // New filterable attributes (populated on re-index) → vector-layer date /
        // person / workspace filtering once the corpus is backfilled.
        created_ms: { type: 'int' as const },
        attendees: { type: 'string' as const, full_text_search: true },
        workspace_id: { type: 'string' as const },
      },
    });
  }

  log.info('indexed_chunks', { chunkCount: chunks.length, meetingTitle, meetingId });
}

export async function deleteMeetingChunks(meetingId: string): Promise<void> {
  try {
    const ns = getNamespace();
    await ns.write({
      delete_by_filter: ['meeting_id', 'Eq', meetingId],
    });
    log.info('deleted_chunks', { meetingId });
  } catch (err) {
    log.warn('delete_chunks_failed', { meetingId, error: err instanceof Error ? err : undefined });
  }
}

// ─── Querying ────────────────────────────────────────────────────────────────

export interface HybridResult {
  id: string;
  meetingId: string;
  meetingTitle: string;
  text: string;
  speakers: string[];
  chunkIndex: number;
  score: number;
  annRank: number | null;
  bm25Rank: number | null;
}

export async function queryHybrid(
  queryVector: number[],
  queryText: string,
  topK: number = 10,
  meetingIdFilter?: string,
): Promise<HybridResult[]> {
  const ns = getNamespace();

  const filters: any = meetingIdFilter
    ? ['meeting_id', 'Eq', meetingIdFilter]
    : undefined;

  const includeAttrs = ['meeting_id', 'meeting_title', 'text', 'speakers', 'chunk_index'];

  const result = await ns.multiQuery({
    queries: [
      {
        rank_by: ['vector', 'ANN', queryVector],
        top_k: topK,
        ...(filters ? { filters } : {}),
        include_attributes: includeAttrs,
      },
      {
        rank_by: ['text', 'BM25', queryText],
        top_k: topK,
        ...(filters ? { filters } : {}),
        include_attributes: includeAttrs,
      },
    ],
  });

  const annRows = result.results?.[0]?.rows ?? [];
  const bm25Rows = result.results?.[1]?.rows ?? [];

  const scoreMap = new Map<string, {
    row: any;
    annRank: number | null;
    bm25Rank: number | null;
    score: number;
  }>();

  for (let rank = 0; rank < annRows.length; rank++) {
    const row = annRows[rank];
    const docId = String(row.id);
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(docId);
    if (existing) {
      existing.annRank = rank + 1;
      existing.score += rrfScore;
    } else {
      scoreMap.set(docId, { row, annRank: rank + 1, bm25Rank: null, score: rrfScore });
    }
  }

  for (let rank = 0; rank < bm25Rows.length; rank++) {
    const row = bm25Rows[rank];
    const docId = String(row.id);
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(docId);
    if (existing) {
      existing.bm25Rank = rank + 1;
      existing.score += rrfScore;
    } else {
      scoreMap.set(docId, { row, annRank: null, bm25Rank: rank + 1, score: rrfScore });
    }
  }

  const fused = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return fused.map((entry) => {
    const row = entry.row;
    const docId = String(row.id);
    const [meetingId] = docId.split(':');
    return {
      id: docId,
      meetingId: String(row.meeting_id ?? meetingId),
      meetingTitle: String(row.meeting_title ?? ''),
      text: String(row.text ?? ''),
      speakers: String(row.speakers ?? '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean),
      chunkIndex: Number(row.chunk_index ?? 0),
      score: entry.score,
      annRank: entry.annRank,
      bm25Rank: entry.bm25Rank,
    };
  });
}

/**
 * Hybrid search constrained to a fixed set of meeting IDs — used by the
 * workspace-scoped chat so semantic search can only return chunks from notes
 * that belong to the workspace (and its folders). We over-fetch then post-filter
 * to the allowed meeting set (avoids needing a Turbopuffer multi-value filter).
 */
export async function queryHybridScoped(
  queryVector: number[],
  queryText: string,
  topK: number,
  allowedMeetingIds: Set<string>,
): Promise<HybridResult[]> {
  if (allowedMeetingIds.size === 0) return [];
  // Over-fetch so enough in-scope chunks survive the filter.
  const wide = Math.min(Math.max(topK * 6, 30), 100);
  const all = await queryHybrid(queryVector, queryText, wide);
  return all.filter((r) => allowedMeetingIds.has(r.meetingId)).slice(0, topK);
}

// ─── Embedding helper ────────────────────────────────────────────────────────

export async function embedQuery(text: string): Promise<number[]> {
  const { batchEmbed } = await import('../lib/knowledgeGraph.utils');
  const results = await batchEmbed([{ id: '__query__', text }]);
  const entry = results.get('__query__');
  if (!entry) throw new Error('Failed to embed query');
  return entry.vector;
}

// ─── Index ledger (Supabase per user — see userLedgerService) ──────────────

// ─── Full pipeline: chunk + embed + upsert ───────────────────────────────────

export async function indexMeetingTranscription(
  meetingId: string,
  meetingTitle: string,
  transcription: string,
  meta?: ChunkMeta,
): Promise<void> {
  if (!isTurbopufferConfigured() || !transcription.trim()) return;

  const { chunkTranscription } = await import('./ragService');
  const { batchEmbed } = await import('../lib/knowledgeGraph.utils');

  const textChunks = chunkTranscription(transcription);
  if (!textChunks.length) return;

  const embedItems = textChunks.map((chunk) => ({
    id: `${meetingId}:${chunk.chunkIndex}`,
    text: chunk.text,
  }));

  const embeddings = await batchEmbed(embedItems);

  const chunksForIndexing: ChunkForIndexing[] = textChunks
    .map((chunk) => {
      const embedding = embeddings.get(`${meetingId}:${chunk.chunkIndex}`);
      if (!embedding) return null;
      return {
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        speakers: chunk.speakers,
        vector: embedding.vector,
      };
    })
    .filter((c): c is ChunkForIndexing => c !== null);

  await upsertMeetingChunks(meetingId, meetingTitle, chunksForIndexing, meta);
  markTurbopufferIndexed(meetingId);
}

export function isAlreadyIndexed(meetingId: string): boolean {
  return isTurbopufferIndexed(meetingId);
}

export function clearIndexLedger(): void {
  clearTurbopufferLedgerState();
}

// ─── Backfill: index only un-indexed meetings ───────────────────────────────

export async function backfillExistingMeetings(
  meetings: Array<{ id: string; title: string; transcription: string }>,
): Promise<void> {
  if (!isTurbopufferConfigured()) return;

  const ledger = getTurbopufferIndexedSet();
  const eligible = meetings.filter(
    m => m.id && m.transcription?.trim() && !ledger.has(m.id),
  );
  if (!eligible.length) {
    log.info('backfill_skipped', { totalMeetings: meetings.length });
    return;
  }

  log.info('backfill_started', { eligible: eligible.length, alreadyIndexed: meetings.length - eligible.length, ledger: ledger.size });

  let indexed = 0;
  for (const meeting of eligible) {
    try {
      await indexMeetingTranscription(meeting.id, meeting.title, meeting.transcription);
      indexed++;
    } catch (err) {
      log.warn('backfill_meeting_failed', { title: meeting.title, error: err instanceof Error ? err : undefined });
    }
  }

  log.info('backfill_complete', { indexed, total: eligible.length });
}

