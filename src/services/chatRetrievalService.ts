import {
  chunkTranscription,
  detectQueryIntent,
  retrieveRelevantChunks,
  type RetrievalResult,
} from './ragService';
import {
  isTurbopufferConfigured,
  queryHybrid,
  embedQuery,
  type HybridResult,
} from './turbopufferService';
import { logger } from '../lib/logger';

const log = logger.scope('ChatRetrieval');

export interface MeetingDocument {
  meetingId: string;
  title: string;
  transcription: string;
  summary?: string;
  notes?: string;
}

export interface RetrievalEvidence {
  meetingId: string;
  meetingTitle: string;
  chunkId: string;
  chunkIndex: number;
  text: string;
  score: number;
  speakers: string[];
  matchedPhrases: string[];
}

export interface RetrievalPlan {
  scope: 'single' | 'many';
  context: string;
  evidence: RetrievalEvidence[];
  confidence: number;
  selectedMeetingIds: string[];
  coveredMeetingsCount: number;
  totalMeetingsCount: number;
  tokenUsage: {
    summaryTokens: number;
    notesTokens: number;
    evidenceTokens: number;
    totalTokens: number;
  };
}

const TOKENS_PER_CHAR = 0.25;
const DEFAULT_TOKEN_BUDGET = 3200;

function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function truncateByTokens(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || !text) return '';
  const maxChars = Math.max(0, Math.floor(tokenBudget / TOKENS_PER_CHAR));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated for token budget ...]`;
}

function stripHtml(text?: string): string {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function confidenceFromResults(results: RetrievalResult[]): number {
  if (!results.length) return 0;
  const top = results[0]?.score ?? 0;
  const avgTop3 =
    results.slice(0, 3).reduce((sum, r) => sum + r.score, 0) /
    Math.min(results.length, 3);
  const coverage = Math.min(1, results.length / 6);
  const scoreSignal = Math.min(1, (top + avgTop3) / 14);
  return Number((0.7 * scoreSignal + 0.3 * coverage).toFixed(3));
}

function dedupeResults(results: RetrievalResult[]): RetrievalResult[] {
  const seen = new Set<string>();
  const deduped: RetrievalResult[] = [];
  for (const result of results) {
    const normalized = result.chunk.text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(result);
  }
  return deduped;
}

export function scoreMeetingCandidate(query: string, meeting: MeetingDocument): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const title = meeting.title.toLowerCase();
  const summary = (meeting.summary || '').toLowerCase();
  const notes = stripHtml(meeting.notes).toLowerCase();
  const transcriptionHead = meeting.transcription.toLowerCase().slice(0, 2800);

  let score = 0;
  if (title.includes(q)) score += 8;
  if (summary.includes(q)) score += 6;
  if (notes.includes(q)) score += 5;
  if (transcriptionHead.includes(q)) score += 4;

  const queryTerms = q.split(/\s+/).filter((t) => t.length > 2);
  for (const term of queryTerms) {
    if (title.includes(term)) score += 2.2;
    if (summary.includes(term)) score += 1.6;
    if (notes.includes(term)) score += 1.3;
    if (transcriptionHead.includes(term)) score += 1.1;
  }

  return score;
}

export function formatEvidence(meetingIndex: number, evidenceIndex: number, evidence: RetrievalEvidence): string {
  const speakerTag = evidence.speakers.length ? ` [${evidence.speakers.join(', ')}]` : '';
  return `Source ${meetingIndex + 1}.${evidenceIndex + 1}${speakerTag} score=${evidence.score.toFixed(2)}\n${evidence.text}`;
}

function isBroadAllMeetingsIntent(query: string): boolean {
  const q = query.toLowerCase();
  const patterns = [
    'all meetings',
    'across meetings',
    'across all meetings',
    'every meeting',
    'all the meetings',
    'from all meetings',
    'from all the meetings',
    'overall',
    'global',
    'main decisions',
    'key decisions',
    'key topics',
    'main topics',
    'what did we decide',
    'all decisions',
    'summarize everything',
    'summary of everything',
    'everything we discussed',
    'all discussions',
  ];
  return patterns.some((p) => q.includes(p));
}

async function retrieveViaHybrid(
  query: string,
  maxEvidenceTokens: number,
  meetingIdFilter?: string,
  meetingTitleHint?: string,
): Promise<{ evidence: RetrievalEvidence[]; confidence: number } | null> {
  if (!isTurbopufferConfigured()) return null;

  try {
    const intent = detectQueryIntent(query);
    const topK = intent === 'overview' ? 14 : 12;
    const queryVector = await embedQuery(query);
    const results = await queryHybrid(queryVector, query, topK, meetingIdFilter);
    if (!results.length) return null;

    const evidence: RetrievalEvidence[] = [];
    let usedTokens = 0;
    for (const r of results) {
      const text = r.text.trim();
      const tokens = estimateTokens(text);
      if (usedTokens + tokens > maxEvidenceTokens) break;
      usedTokens += tokens;
      evidence.push({
        meetingId: r.meetingId,
        meetingTitle: r.meetingTitle || meetingTitleHint || '',
        chunkId: r.id,
        chunkIndex: r.chunkIndex,
        text,
        score: r.score * 10,
        speakers: r.speakers,
        matchedPhrases: [],
      });
    }

    const confidence = Math.min(1, results.length > 0
      ? 0.5 + 0.5 * Math.min(1, evidence.length / 6)
      : 0);

    return { evidence, confidence };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    const isNotFound = msg.includes('404') || msg.includes('not found');
    if (!isNotFound) {
      log.warn('hybrid_query_failed', { error: err instanceof Error ? err : undefined });
    }
    return null;
  }
}

function retrieveViaLocalBM25(
  query: string,
  meeting: MeetingDocument,
  maxEvidenceTokens: number,
): Promise<{ evidence: RetrievalEvidence[]; confidence: number }> {
  return retrieveMeetingEvidenceBM25(query, meeting, maxEvidenceTokens);
}

async function retrieveMeetingEvidenceBM25(
  query: string,
  meeting: MeetingDocument,
  maxEvidenceTokens: number,
): Promise<{ evidence: RetrievalEvidence[]; confidence: number }> {
  const intent = detectQueryIntent(query);
  const initialTopK = intent === 'overview' ? 8 : 5;
  const expandedTopK = intent === 'overview' ? 12 : 8;
  const chunks = chunkTranscription(meeting.transcription || '');
  if (!chunks.length) return { evidence: [], confidence: 0 };

  let results = await retrieveRelevantChunks(query, chunks, initialTopK);
  let confidence = confidenceFromResults(results);
  if (confidence < 0.4) {
    results = await retrieveRelevantChunks(query, chunks, expandedTopK);
    confidence = confidenceFromResults(results);
  }
  results = dedupeResults(results);

  const evidence: RetrievalEvidence[] = [];
  let usedTokens = 0;
  for (const result of results) {
    const evidenceText = result.chunk.text.trim();
    const evidenceTokens = estimateTokens(evidenceText);
    if (usedTokens + evidenceTokens > maxEvidenceTokens) break;
    usedTokens += evidenceTokens;
    evidence.push({
      meetingId: meeting.meetingId,
      meetingTitle: meeting.title,
      chunkId: result.chunk.id,
      chunkIndex: result.chunk.chunkIndex,
      text: evidenceText,
      score: result.score,
      speakers: result.chunk.speakers,
      matchedPhrases: result.matchedPhrases,
    });
  }

  return { evidence, confidence };
}

export async function retrieveMeetingEvidence(
  query: string,
  meeting: MeetingDocument,
  maxEvidenceTokens: number,
): Promise<{ evidence: RetrievalEvidence[]; confidence: number }> {
  const hybridResult = await retrieveViaHybrid(
    query, maxEvidenceTokens, meeting.meetingId, meeting.title,
  );
  if (hybridResult && hybridResult.evidence.length > 0) {
    return hybridResult;
  }
  return retrieveViaLocalBM25(query, meeting, maxEvidenceTokens);
}

export async function retrieveForSingleMeeting(params: {
  query: string;
  meeting: MeetingDocument;
  totalTokenBudget?: number;
}): Promise<RetrievalPlan> {
  const totalTokenBudget = params.totalTokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const summaryBudget = 240;
  const notesBudget = 420;
  const evidenceBudget = Math.max(700, totalTokenBudget - summaryBudget - notesBudget - 220);

  const cleanSummary = truncateByTokens(params.meeting.summary || '', summaryBudget);
  const cleanNotes = truncateByTokens(stripHtml(params.meeting.notes), notesBudget);
  const { evidence, confidence } = await retrieveMeetingEvidence(
    params.query,
    params.meeting,
    evidenceBudget,
  );

  const contextBlocks: string[] = [];
  if (cleanSummary) contextBlocks.push(`=== AI-GENERATED MEETING SUMMARY ===\n${cleanSummary}`);
  if (cleanNotes) contextBlocks.push(`=== MEETING NOTES ===\n${cleanNotes}`);
  if (evidence.length) {
    const evidenceText = evidence
      .map((e, index) => formatEvidence(0, index, e))
      .join('\n\n');
    contextBlocks.push(`=== TRANSCRIPTION EVIDENCE ===\n${evidenceText}`);
  } else {
    contextBlocks.push(
      `=== TRANSCRIPTION EVIDENCE ===\nNo high-confidence transcript evidence found. Use available summary/notes and clearly state uncertainty.`,
    );
  }

  const context = contextBlocks.join('\n\n');
  return {
    scope: 'single',
    context,
    evidence,
    confidence,
    selectedMeetingIds: [params.meeting.meetingId],
    coveredMeetingsCount: 1,
    totalMeetingsCount: 1,
    tokenUsage: {
      summaryTokens: estimateTokens(cleanSummary),
      notesTokens: estimateTokens(cleanNotes),
      evidenceTokens: estimateTokens(contextBlocks[contextBlocks.length - 1] || ''),
      totalTokens: estimateTokens(context),
    },
  };
}

export async function retrieveForManyMeetings(params: {
  query: string;
  meetings: MeetingDocument[];
  totalTokenBudget?: number;
  maxMeetings?: number;
}): Promise<RetrievalPlan> {
  const totalTokenBudget = params.totalTokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const broadIntent = isBroadAllMeetingsIntent(params.query);

  // For broad queries ("all meetings"), use ALL meetings — no cap.
  // For targeted queries, use maxMeetings param or a reasonable default.
  const maxMeetings = broadIntent
    ? params.meetings.length
    : (params.maxMeetings ?? 8);

  // Try cross-meeting hybrid search first (single round-trip)
  if (isTurbopufferConfigured()) {
    try {
      const crossResult = await retrieveViaHybrid(params.query, totalTokenBudget - 200);
      if (crossResult && crossResult.evidence.length > 0) {
        const coveredMeetingIds = [...new Set(crossResult.evidence.map(e => e.meetingId))];

        const meetingTitleMap = new Map(params.meetings.map(m => [m.meetingId, m.title]));
        const enrichedEvidence = crossResult.evidence.map(e => ({
          ...e,
          meetingTitle: e.meetingTitle || meetingTitleMap.get(e.meetingId) || '',
        }));

        const summaryBlocks: string[] = [];
        if (broadIntent) {
          for (const m of params.meetings) {
            if (m.summary) {
              summaryBlocks.push(`- ${m.title}: ${truncateByTokens(m.summary, 60)}`);
            }
          }
        } else {
          for (const mid of coveredMeetingIds) {
            const m = params.meetings.find(mm => mm.meetingId === mid);
            if (m?.summary) {
              summaryBlocks.push(`- ${m.title}: ${truncateByTokens(m.summary, 90)}`);
            }
          }
        }

        const meetingIndexMap = new Map<string, number>();
        coveredMeetingIds.forEach((id, idx) => meetingIndexMap.set(id, idx));

        const evidenceText = enrichedEvidence
          .sort((a, b) => {
            const ma = meetingIndexMap.get(a.meetingId) ?? 99;
            const mb = meetingIndexMap.get(b.meetingId) ?? 99;
            if (ma !== mb) return ma - mb;
            return a.chunkIndex - b.chunkIndex;
          })
          .map((e, idx) => formatEvidence(meetingIndexMap.get(e.meetingId) ?? 0, idx, e))
          .join('\n\n');

        const context = [
          `=== COVERAGE ===\nMeetings with evidence: ${coveredMeetingIds.length}/${params.meetings.length}${broadIntent ? ' (user asked for ALL meetings)' : ''}`,
          `=== SELECTED MEETINGS (${coveredMeetingIds.length}) ===\n${coveredMeetingIds.map((id, idx) => `${idx + 1}. ${meetingTitleMap.get(id) || id}`).join('\n')}`,
          summaryBlocks.length ? `=== MEETING SUMMARIES (COMPACT) ===\n${summaryBlocks.join('\n')}` : '',
          evidenceText
            ? `=== CROSS-MEETING EVIDENCE ===\n${evidenceText}`
            : '=== CROSS-MEETING EVIDENCE ===\nNo high-confidence transcript evidence found.',
        ].filter(Boolean).join('\n\n');

        return {
          scope: 'many',
          context,
          evidence: enrichedEvidence,
          confidence: crossResult.confidence,
          selectedMeetingIds: coveredMeetingIds,
          coveredMeetingsCount: coveredMeetingIds.length,
          totalMeetingsCount: params.meetings.length,
          tokenUsage: {
            summaryTokens: estimateTokens(summaryBlocks.join('\n')),
            notesTokens: 0,
            evidenceTokens: estimateTokens(evidenceText),
            totalTokens: estimateTokens(context),
          },
        };
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (!msg.includes('404') && !msg.includes('not found')) {
        log.warn('cross_meeting_query_failed', { error: err instanceof Error ? err : undefined });
      }
    }
  }

  // ── BM25 fallback ──────────────────────────────────────────────────────────
  // For broad queries, use summary-based approach to cover ALL meetings
  // instead of running BM25 on each one (too slow for 89+ meetings).
  if (broadIntent) {
    return buildBroadSummaryContext(params.query, params.meetings, totalTokenBudget);
  }

  // For targeted queries, BM25 on top-ranked meetings
  const rankedMeetings = [...params.meetings]
    .map((m) => ({ meeting: m, score: scoreMeetingCandidate(params.query, m) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMeetings)
    .map((entry) => entry.meeting);

  if (!rankedMeetings.length) {
    return {
      scope: 'many',
      context: 'No meetings available for retrieval.',
      evidence: [],
      confidence: 0,
      selectedMeetingIds: [],
      coveredMeetingsCount: 0,
      totalMeetingsCount: params.meetings.length,
      tokenUsage: { summaryTokens: 0, notesTokens: 0, evidenceTokens: 0, totalTokens: 0 },
    };
  }

  const evidenceBudget = Math.max(900, totalTokenBudget - 420);
  const perMeetingEvidenceBudget = Math.max(220, Math.floor(evidenceBudget / rankedMeetings.length));
  const perMeetingSummaryBudget = 90;

  let allEvidence: RetrievalEvidence[] = [];
  let confidenceSum = 0;
  const summaryBlocks: string[] = [];

  for (const meeting of rankedMeetings) {
    const compactSummary = truncateByTokens(meeting.summary || '', perMeetingSummaryBudget);
    if (compactSummary) {
      summaryBlocks.push(`- ${meeting.title}: ${compactSummary}`);
    }
    const { evidence, confidence } = await retrieveMeetingEvidence(
      params.query,
      meeting,
      perMeetingEvidenceBudget,
    );
    confidenceSum += confidence;
    allEvidence = allEvidence.concat(evidence);
  }

  allEvidence.sort((a, b) => b.score - a.score);
  const dedupedEvidence = (() => {
    const seen = new Set<string>();
    const output: RetrievalEvidence[] = [];
    for (const item of allEvidence) {
      const key = `${item.meetingId}:${item.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 140)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
      if (output.length >= 40) break;
    }
    return output;
  })();

  const meetingIndexMap = new Map<string, number>();
  rankedMeetings.forEach((meeting, idx) => meetingIndexMap.set(meeting.meetingId, idx));

  const evidenceText = dedupedEvidence
    .sort((a, b) => {
      const ma = meetingIndexMap.get(a.meetingId) ?? 99;
      const mb = meetingIndexMap.get(b.meetingId) ?? 99;
      if (ma !== mb) return ma - mb;
      return a.chunkIndex - b.chunkIndex;
    })
    .map((e, idx) => formatEvidence(meetingIndexMap.get(e.meetingId) ?? 0, idx, e))
    .join('\n\n');

  const coveredMeetingIds = [...new Set(dedupedEvidence.map(e => e.meetingId))];

  const context = [
    `=== COVERAGE ===\nMeetings with evidence: ${coveredMeetingIds.length}/${params.meetings.length}`,
    `=== SELECTED MEETINGS (${rankedMeetings.length}) ===\n${rankedMeetings.map((m, idx) => `${idx + 1}. ${m.title}`).join('\n')}`,
    summaryBlocks.length ? `=== MEETING SUMMARIES (COMPACT) ===\n${summaryBlocks.join('\n')}` : '',
    evidenceText
      ? `=== CROSS-MEETING EVIDENCE ===\n${evidenceText}`
      : '=== CROSS-MEETING EVIDENCE ===\nNo high-confidence transcript evidence found. Explicitly state this and avoid speculation.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    scope: 'many',
    context,
    evidence: dedupedEvidence,
    confidence: Number((confidenceSum / rankedMeetings.length).toFixed(3)),
    selectedMeetingIds: rankedMeetings.map((m) => m.meetingId),
    coveredMeetingsCount: coveredMeetingIds.length,
    totalMeetingsCount: params.meetings.length,
    tokenUsage: {
      summaryTokens: estimateTokens(summaryBlocks.join('\n')),
      notesTokens: 0,
      evidenceTokens: estimateTokens(evidenceText),
      totalTokens: estimateTokens(context),
    },
  };
}

function buildBroadSummaryContext(
  query: string,
  meetings: MeetingDocument[],
  totalTokenBudget: number,
): RetrievalPlan {
  const perMeetingBudget = Math.max(40, Math.floor((totalTokenBudget * 0.85) / Math.max(1, meetings.length)));
  const summaryBlocks: string[] = [];
  const coveredIds: string[] = [];

  for (const m of meetings) {
    const summary = m.summary || '';
    if (!summary.trim()) continue;
    summaryBlocks.push(`### ${m.title}\n${truncateByTokens(summary, perMeetingBudget)}`);
    coveredIds.push(m.meetingId);
  }

  const context = [
    `=== COVERAGE ===\nBroad query across ALL ${meetings.length} meetings. Summaries provided for ${coveredIds.length} meetings.`,
    `=== ALL MEETING SUMMARIES ===\n${summaryBlocks.join('\n\n')}`,
  ].join('\n\n');

  return {
    scope: 'many',
    context,
    evidence: [],
    confidence: coveredIds.length > 0 ? 0.7 : 0,
    selectedMeetingIds: coveredIds,
    coveredMeetingsCount: coveredIds.length,
    totalMeetingsCount: meetings.length,
    tokenUsage: {
      summaryTokens: estimateTokens(context),
      notesTokens: 0,
      evidenceTokens: 0,
      totalTokens: estimateTokens(context),
    },
  };
}

// ─── Cross-meeting retrieval (single Turbopuffer round-trip) ─────────────────

export interface CrossMeetingResult {
  evidence: RetrievalEvidence[];
  meetingGroups: Array<{
    meetingId: string;
    meetingTitle: string;
    chunks: RetrievalEvidence[];
  }>;
  coveredMeetingIds: string[];
  confidence: number;
  context: string;
  totalMeetingsCount: number;
}

export async function retrieveCrossMeeting(params: {
  query: string;
  topK?: number;
  isBroad?: boolean;
  totalMeetingsCount: number;
  meetingTitleMap?: Map<string, string>;
  meetingSummaryMap?: Map<string, string>;
}): Promise<CrossMeetingResult | null> {
  if (!isTurbopufferConfigured()) return null;

  try {
    const topK = params.topK ?? 30;
    const isBroad = params.isBroad ?? false;
    const queryVector = await embedQuery(params.query);
    const results = await queryHybrid(queryVector, params.query, topK);
    if (!results.length) return null;

    const evidence: RetrievalEvidence[] = results.map(r => ({
      meetingId: r.meetingId,
      meetingTitle: r.meetingTitle || params.meetingTitleMap?.get(r.meetingId) || '',
      chunkId: r.id,
      chunkIndex: r.chunkIndex,
      text: r.text.trim(),
      score: r.score * 10,
      speakers: r.speakers,
      matchedPhrases: [],
    }));

    const groupMap = new Map<string, RetrievalEvidence[]>();
    for (const e of evidence) {
      const arr = groupMap.get(e.meetingId) || [];
      arr.push(e);
      groupMap.set(e.meetingId, arr);
    }

    const meetingGroups = Array.from(groupMap.entries()).map(([meetingId, chunks]) => ({
      meetingId,
      meetingTitle: chunks[0]?.meetingTitle || params.meetingTitleMap?.get(meetingId) || '',
      chunks: chunks.sort((a, b) => a.chunkIndex - b.chunkIndex),
    }));

    const evidenceMatchedIds = new Set(meetingGroups.map(g => g.meetingId));

    // For broad queries, include summaries from ALL meetings (not just ones with evidence).
    // This ensures the LLM knows about every meeting even if Turbopuffer only returned chunks from a subset.
    const summaryBlocks: string[] = [];
    let allCoveredIds: string[] = [];

    if (isBroad && params.meetingSummaryMap) {
      const perSummaryBudget = Math.max(40, Math.floor(3000 / Math.max(1, params.meetingSummaryMap.size)));
      for (const [mid, summary] of params.meetingSummaryMap) {
        const title = params.meetingTitleMap?.get(mid) || mid;
        const hasEvidence = evidenceMatchedIds.has(mid);
        summaryBlocks.push(`- ${title}${hasEvidence ? ' *' : ''}: ${truncateByTokens(summary, perSummaryBudget)}`);
        allCoveredIds.push(mid);
      }
    } else if (params.meetingSummaryMap) {
      for (const mid of evidenceMatchedIds) {
        const summary = params.meetingSummaryMap.get(mid);
        const title = params.meetingTitleMap?.get(mid) || mid;
        if (summary) {
          summaryBlocks.push(`- ${title}: ${truncateByTokens(summary, 90)}`);
        }
      }
      allCoveredIds = Array.from(evidenceMatchedIds);
    } else {
      allCoveredIds = Array.from(evidenceMatchedIds);
    }

    const evidenceText = meetingGroups
      .map((group, mIdx) =>
        group.chunks.map((e, eIdx) => formatEvidence(mIdx, eIdx, e)).join('\n\n')
      )
      .join('\n\n');

    const coverageCount = isBroad ? allCoveredIds.length : evidenceMatchedIds.size;

    const context = [
      isBroad
        ? `=== COVERAGE ===\nUser asked for ALL meetings. Summaries provided for ${allCoveredIds.length}/${params.totalMeetingsCount} meetings. Deep evidence from ${evidenceMatchedIds.size} meetings (* marked in summaries).`
        : `=== COVERAGE ===\nMeetings with relevant evidence: ${evidenceMatchedIds.size}/${params.totalMeetingsCount}`,
      isBroad
        ? ''
        : `=== MEETINGS FOUND ===\n${meetingGroups.map((g, idx) => `${idx + 1}. ${g.meetingTitle} (${g.chunks.length} chunks)`).join('\n')}`,
      summaryBlocks.length
        ? `=== MEETING SUMMARIES (${summaryBlocks.length}) ===\n${summaryBlocks.join('\n')}`
        : '',
      evidenceText
        ? `=== CROSS-MEETING EVIDENCE ===\n${evidenceText}`
        : '=== CROSS-MEETING EVIDENCE ===\nNo relevant transcript evidence found.',
    ].filter(Boolean).join('\n\n');

    const confidence = Math.min(1, 0.5 + 0.5 * Math.min(1, evidence.length / 10));

    return {
      evidence,
      meetingGroups,
      coveredMeetingIds: allCoveredIds,
      confidence,
      context,
      totalMeetingsCount: params.totalMeetingsCount,
    };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (!msg.includes('404') && !msg.includes('not found')) {
      log.warn('cross_meeting_query_failed', { error: err instanceof Error ? err : undefined });
    }
    return null;
  }
}
