import { Turbopuffer } from '@turbopuffer/turbopuffer';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { logger } from '../lib/logger';

const log = logger.scope('Turbopuffer');

const NAMESPACE = 'lumina-meetings';
const RRF_K = 60;

function getTurbopufferApiKey(): string {
  return (
    (import.meta as any).env?.VITE_TURBOPUFFER_API_KEY ||
    process.env.TURBOPUFFER_API_KEY ||
    ''
  );
}

let _client: Turbopuffer | null = null;

function getClient(): Turbopuffer {
  if (!_client) {
    const apiKey = getTurbopufferApiKey();
    if (!apiKey) throw new Error('VITE_TURBOPUFFER_API_KEY is not configured');
    _client = new Turbopuffer({
      apiKey,
      region: 'gcp-us-central1',
      fetch: tauriFetch as unknown as typeof globalThis.fetch,
    });
  }
  return _client;
}

function getNamespace() {
  return getClient().namespace(NAMESPACE);
}

export function isTurbopufferConfigured(): boolean {
  return !!getTurbopufferApiKey();
}

// ─── Indexing ────────────────────────────────────────────────────────────────

export interface ChunkForIndexing {
  chunkIndex: number;
  text: string;
  speakers: string[];
  vector: number[];
}

export async function upsertMeetingChunks(
  meetingId: string,
  meetingTitle: string,
  chunks: ChunkForIndexing[],
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

  const BATCH_SIZE = 100;
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
      })),
      distance_metric: 'cosine_distance',
      schema: {
        text: { type: 'string' as const, full_text_search: true },
        meeting_id: { type: 'string' as const },
        meeting_title: { type: 'string' as const, filterable: false },
        speakers: { type: 'string' as const, filterable: false },
        chunk_index: { type: 'int' as const },
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

// ─── Embedding helper ────────────────────────────────────────────────────────

export async function embedQuery(text: string): Promise<number[]> {
  const { batchEmbed } = await import('../lib/knowledgeGraph.utils');
  const results = await batchEmbed([{ id: '__query__', text }]);
  const entry = results.get('__query__');
  if (!entry) throw new Error('Failed to embed query');
  return entry.vector;
}

// ─── Index ledger (localStorage) ─────────────────────────────────────────────

const LEDGER_KEY = 'tpuf_indexed_meetings';

function readLedger(): Set<string> {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeLedger(ids: Set<string>): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* storage full — non-critical */ }
}

function markIndexed(meetingId: string): void {
  const ids = readLedger();
  ids.add(meetingId);
  writeLedger(ids);
}

export function isAlreadyIndexed(meetingId: string): boolean {
  return readLedger().has(meetingId);
}

export function clearIndexLedger(): void {
  localStorage.removeItem(LEDGER_KEY);
}

// ─── Full pipeline: chunk + embed + upsert ───────────────────────────────────

export async function indexMeetingTranscription(
  meetingId: string,
  meetingTitle: string,
  transcription: string,
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

  await upsertMeetingChunks(meetingId, meetingTitle, chunksForIndexing);
  markIndexed(meetingId);
}

// ─── Backfill: index only un-indexed meetings ───────────────────────────────

export async function backfillExistingMeetings(
  meetings: Array<{ id: string; title: string; transcription: string }>,
): Promise<void> {
  if (!isTurbopufferConfigured()) return;

  const ledger = readLedger();
  const eligible = meetings.filter(
    m => m.id && m.transcription?.trim() && !ledger.has(m.id),
  );
  if (!eligible.length) {
    log.info('backfill_skipped', { totalMeetings: meetings.length });
    return;
  }

  log.info('backfill_started', { eligible: eligible.length, alreadyIndexed: meetings.length - eligible.length });

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
