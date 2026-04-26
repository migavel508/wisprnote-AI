import { logger } from './logger';

const log = logger.scope('KnowledgeGraph');

// ============================================================
// Piece 1 — Types
// ============================================================

export interface MeetingRecord {
  meetingId: string;
  meetingTitle: string;
  meetingDate?: string; // ISO 8601 date string, optional
  topics: Array<{
    name: string;
    status: string;
    summary: string;
  }>;
  decisions: Array<{
    decision: string;
    relatedTopic?: string;
  }>;
  people: string[];
  actionItems: Array<{
    task: string;
    owner: string;
    relatedTopic?: string;
  }>;
  references?: any[];
}

export interface EmbeddingVector {
  id: string;
  text: string;
  vector: number[];
}

export interface ExtractedRelationship {
  fromMeetingId: string;
  toMeetingId: string;
  relationshipType: 'continuation' | 'resolution' | 'escalation' | 'recurring' | 'reference';
  sharedThread: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface MeetingEdge {
  meetingId: string;
  meeting: MeetingRecord;
  embeddingScore: number;
  contextualScore: number;
  totalScore: number;
  relationships: ExtractedRelationship[];
}

export interface KGBuildArtifact {
  nodes: any[];
  links: any[];
  meetingEdgeMatrix: Map<string, MeetingEdge[]>;
  embeddings: Map<string, EmbeddingVector>;
  relationships: ExtractedRelationship[];
}

export interface CanonicalTopicEntry {
  label: string;
  firstSeen: string | null;
  lastSeen: string | null;
  vector: number[];
  occurrences: number;
  status: string;
  summary: string;
}

// ============================================================
// Piece 2 — Constants
// ============================================================

const EMBED_BATCH_SIZE = 80;
const TOPIC_MERGE_THRESHOLD = 0.82;
const EDGE_MIN_SCORE = 0.5;
const TOP_K_EDGES = 5;
const TEMPORAL_SPLIT_DAYS = 90;

const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_FALLBACKS = ['gemini-embedding-001', 'text-embedding-004'];
const EXTRACT_MODEL = 'gemini-3-flash-preview';

function getApiKey(): string {
  // Try Vite's import.meta.env first, then the define'd process.env fallback
  const key =
    import.meta.env.VITE_GEMINI_API_KEY ||
    import.meta.env.GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing GEMINI_API_KEY — set VITE_GEMINI_API_KEY or GEMINI_API_KEY in your .env');
  return key;
}

// ============================================================
// Piece 3 — Cosine similarity
// ============================================================

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

function clampedCosine(a: number[], b: number[]): number {
  return Math.max(0, cosineSimilarity(a, b));
}

// ============================================================
// Piece 4 — Text builders for embedding
// ============================================================

export function buildTopicEmbedText(topic: { name: string; status?: string; summary?: string }): string {
  const parts: string[] = [`Topic: ${topic.name}.`];
  if (topic.status) parts.push(`Status: ${topic.status}.`);
  if (topic.summary) parts.push(topic.summary);
  return parts.join(' ');
}

export function buildMeetingEmbedText(meeting: MeetingRecord): string {
  const parts: string[] = [];
  parts.push(`Meeting: ${meeting.meetingTitle}.`);

  if (meeting.topics?.length) {
    const topicTexts = meeting.topics.map(
      t => `${t.name} (${t.status}): ${t.summary}`
    );
    parts.push(`Topics discussed: ${topicTexts.join('; ')}.`);
  }

  if (meeting.decisions?.length) {
    parts.push(
      `Decisions: ${meeting.decisions.map(d => d.decision).join('; ')}.`
    );
  }

  if (meeting.people?.length) {
    parts.push(`Participants: ${meeting.people.join(', ')}.`);
  }

  return parts.join(' ');
}

// ============================================================
// Piece 5 — Batch embedding function
// ============================================================

let currentEmbedModel = EMBED_MODEL;

// ── Persistent cache helpers (localStorage) ─────────────────────────────────
// Two-tier: in-memory Map (hot) + localStorage (cold, survives reloads).
const LS_EMBED_KEY = 'kg_embed_cache';
const LS_REL_KEY = 'kg_rel_cache';

function loadEmbedCacheFromStorage(): Map<string, number[]> {
  try {
    const raw = localStorage.getItem(LS_EMBED_KEY);
    if (!raw) return new Map();
    const entries: [string, number[]][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveEmbedCacheToStorage(cache: Map<string, number[]>) {
  try {
    // Keep max 2000 entries (~4 MB) to avoid localStorage quota issues
    const entries = [...cache.entries()].slice(-2000);
    localStorage.setItem(LS_EMBED_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded — silently fail, in-memory cache still works
  }
}

function loadRelCacheFromStorage(): { key: string; value: ExtractedRelationship[] } {
  try {
    const raw = localStorage.getItem(LS_REL_KEY);
    if (!raw) return { key: '', value: [] };
    return JSON.parse(raw);
  } catch {
    return { key: '', value: [] };
  }
}

function saveRelCacheToStorage(key: string, value: ExtractedRelationship[]) {
  try {
    localStorage.setItem(LS_REL_KEY, JSON.stringify({ key, value }));
  } catch { /* quota exceeded */ }
}

// ── Module-level embedding cache ─────────────────────────────────────────────
// Key: the exact text being embedded → Value: embedding vector.
// Hydrated from localStorage on module load; persisted after each batch.
const _embedCache = loadEmbedCacheFromStorage();

// ── Module-level relationship cache ──────────────────────────────────────────
// Key: sorted meetingId fingerprint. Invalidated only when the meeting set changes.
const _storedRel = loadRelCacheFromStorage();
let _relCacheKey = _storedRel.key;
let _relCacheValue: ExtractedRelationship[] = _storedRel.value;

// Retry helper with exponential backoff for 503 / 429 errors
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 4,
  baseDelayMs = 2000
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, init);
    if (response.ok || (response.status !== 503 && response.status !== 429)) {
      return response;
    }
    lastResponse = response;
    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      log.warn('api_retry', { status: response.status, delayMs: Math.round(delay), attempt: attempt + 1, maxRetries });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return lastResponse!;
}

export async function batchEmbed(
  items: Array<{ id: string; text: string }>
): Promise<Map<string, EmbeddingVector>> {
  const apiKey = getApiKey();
  const result = new Map<string, EmbeddingVector>();

  // Serve cache hits immediately — no API call needed
  const uncached = items.filter(item => {
    const cached = _embedCache.get(item.text);
    if (cached) {
      result.set(item.id, { id: item.id, text: item.text, vector: cached });
      return false;
    }
    return true;
  });

  if (uncached.length === 0) return result;
  log.debug('batch_embed', { cacheHits: result.size, apiCalls: uncached.length });

  for (let start = 0; start < uncached.length; start += EMBED_BATCH_SIZE) {
    const batch = uncached.slice(start, start + EMBED_BATCH_SIZE);

    // Try the currently-known-good model first, then any other known fallbacks
    // on 404. Race-safe: parallel callers each independently find a working model
    // and converge on the shared `currentEmbedModel`.
    const candidates = [
      currentEmbedModel,
      ...EMBED_FALLBACKS.filter(m => m !== currentEmbedModel),
    ];

    let response: Response | null = null;
    let lastErrorBody = '';
    for (const model of candidates) {
      const modelPath = `models/${model}`;
      const requestBody = {
        requests: batch.map(item => ({
          model: modelPath,
          content: { parts: [{ text: item.text }] },
          taskType: 'SEMANTIC_SIMILARITY',
        })),
      };

      response = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        }
      );

      if (response.ok) {
        if (currentEmbedModel !== model) {
          log.warn('embedding_model_switched', { from: currentEmbedModel, to: model });
          currentEmbedModel = model;
        }
        break;
      }

      // Only fall through to next candidate on 404 (model not available).
      // Other errors (auth, quota, server) should bubble up immediately.
      if (response.status !== 404) break;
      lastErrorBody = await response.clone().text();
    }

    if (!response || !response.ok) {
      const body = response ? await response.text() : lastErrorBody;
      throw new Error(`Embedding API error ${response?.status ?? 'unknown'}: ${body}`);
    }

    const data = await response.json();
    const embeddings: Array<{ values: number[] }> = data.embeddings;

    for (let i = 0; i < batch.length; i++) {
      const vector = embeddings[i].values;
      _embedCache.set(batch[i].text, vector); // populate cache
      result.set(batch[i].id, {
        id: batch[i].id,
        text: batch[i].text,
        vector,
      });
    }
  }

  // Persist to localStorage so embeddings survive reloads
  saveEmbedCacheToStorage(_embedCache);

  return result;
}

// ============================================================
// Piece 6 — Canonical topic map and deduplication
// ============================================================

const STATUS_SEVERITY: Record<string, number> = {
  'off-track': 4,
  revisited: 3,
  ongoing: 2,
  default: 1,
  resolved: 0,
};

function statusSeverity(s: string): number {
  return STATUS_SEVERITY[s] ?? STATUS_SEVERITY['default'];
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs(da - db) / (1000 * 60 * 60 * 24);
}

export function findCanonicalTopicIdByEmbedding(
  topic: { name: string; status?: string; summary?: string },
  vector: number[],
  canonicalMap: Record<string, CanonicalTopicEntry>,
  meetingDate?: string
): string {
  const baseId = `topic_${topic.name.toLowerCase().replace(/\s+/g, '_')}`;

  // Case: exact base ID exists
  if (canonicalMap[baseId]) {
    const entry = canonicalMap[baseId];
    // Temporal split guard
    if (
      meetingDate &&
      entry.lastSeen &&
      daysBetween(meetingDate, entry.lastSeen) > TEMPORAL_SPLIT_DAYS
    ) {
      const year = new Date(meetingDate).getFullYear();
      const splitId = `${baseId}_${year}`;
      if (!canonicalMap[splitId]) {
        canonicalMap[splitId] = {
          label: topic.name,
          firstSeen: meetingDate,
          lastSeen: meetingDate,
          vector,
          occurrences: 1,
          status: topic.status || 'default',
          summary: topic.summary || '',
        };
      }
      return splitId;
    }
    // Update existing
    entry.occurrences++;
    if (meetingDate) entry.lastSeen = meetingDate;
    if (statusSeverity(topic.status || 'default') > statusSeverity(entry.status)) {
      entry.status = topic.status || 'default';
    }
    if (topic.summary) entry.summary = topic.summary;
    return baseId;
  }

  // Case: no exact match — scan for semantic match
  for (const [existingId, entry] of Object.entries(canonicalMap)) {
    const sim = clampedCosine(vector, entry.vector);
    if (sim >= TOPIC_MERGE_THRESHOLD) {
      // Temporal guard on semantic match too
      if (
        meetingDate &&
        entry.lastSeen &&
        daysBetween(meetingDate, entry.lastSeen) > TEMPORAL_SPLIT_DAYS
      ) {
        continue; // skip this match, look for others or create new
      }
      entry.occurrences++;
      if (meetingDate) entry.lastSeen = meetingDate;
      if (statusSeverity(topic.status || 'default') > statusSeverity(entry.status)) {
        entry.status = topic.status || 'default';
      }
      if (topic.summary) entry.summary = topic.summary;
      return existingId;
    }
  }

  // Case: no match — create new
  canonicalMap[baseId] = {
    label: topic.name,
    firstSeen: meetingDate || null,
    lastSeen: meetingDate || null,
    vector,
    occurrences: 1,
    status: topic.status || 'default',
    summary: topic.summary || '',
  };
  return baseId;
}

// ============================================================
// Piece 7 — Contextual relationship extraction
// ============================================================

function buildMeetingSummary(m: MeetingRecord): string {
  const lines: string[] = [
    `ID: ${m.meetingId}`,
    `Title: ${m.meetingTitle}`,
  ];
  if (m.meetingDate) lines.push(`Date: ${m.meetingDate}`);
  if (m.topics?.length) {
    lines.push(
      `Topics: ${m.topics.map(t => `${t.name} [${t.status}]: ${t.summary}`).join(' | ')}`
    );
  }
  if (m.decisions?.length) {
    lines.push(`Decisions: ${m.decisions.map(d => d.decision).join(' | ')}`);
  }
  if (m.actionItems?.length) {
    lines.push(
      `Open actions: ${m.actionItems.map(a => `${a.owner}: ${a.task}`).join(' | ')}`
    );
  }
  return lines.join('\n');
}

export async function extractContextualRelationships(
  kgData: MeetingRecord[]
): Promise<ExtractedRelationship[]> {
  if (kgData.length < 2) return [];

  const apiKey = getApiKey();

  // Return cached relationships if the meeting set is unchanged
  const fingerprint = kgData.map(m => m.meetingId).sort().join('|');
  if (_relCacheKey === fingerprint) {
    log.debug('relationships_cache_hit');
    return _relCacheValue;
  }

  // Determine if we can do an incremental extraction (much cheaper)
  const cachedIds = new Set(_relCacheKey ? _relCacheKey.split('|') : []);
  const currentIds = new Set(kgData.map(m => m.meetingId));
  const newMeetings = kgData.filter(m => !cachedIds.has(m.meetingId));
  const removedIds = [...cachedIds].filter(id => !currentIds.has(id));
  const canIncremental = _relCacheValue.length > 0
    && removedIds.length === 0
    && newMeetings.length > 0
    && newMeetings.length <= Math.max(3, kgData.length * 0.3);

  let prompt: string;

  if (canIncremental) {
    // Incremental: send only new meetings + condensed existing relationships
    const newSummaries = newMeetings.map(buildMeetingSummary).join('\n---\n');
    const existingRelSummary = _relCacheValue
      .map(r => `${r.fromMeetingId} → ${r.toMeetingId}: ${r.relationshipType} (${r.confidence}) — ${r.sharedThread}`)
      .join('\n');
    const existingMeetingIds = kgData
      .filter(m => cachedIds.has(m.meetingId))
      .map(m => `${m.meetingId}: ${m.meetingTitle} — topics: ${(m.topics || []).map(t => t.name).join(', ')}`)
      .join('\n');

    prompt = `You are analyzing NEW meeting records to find contextual relationships with existing meetings.

EXISTING MEETINGS (condensed):
${existingMeetingIds}

EXISTING RELATIONSHIPS (already found):
${existingRelSummary || 'None yet.'}

NEW MEETINGS (full detail):
${newSummaries}

Find relationships between the NEW meetings and ANY other meeting (existing or new). Do NOT re-generate relationships that are already listed above.

Return a JSON array of NEW relationship objects only. Each object must have exactly these fields:
- "fromMeetingId": string (the earlier/source meeting ID)
- "toMeetingId": string (the later/target meeting ID)
- "relationshipType": one of "continuation", "resolution", "escalation", "recurring", "reference"
- "sharedThread": string (one sentence describing what connects them)
- "confidence": one of "high", "medium", "low"

Return ONLY the JSON array, no markdown fences, no explanation.
If no new relationships are found, return an empty array [].`;

    log.info('relationships_incremental', { newMeetings: newMeetings.length, cached: _relCacheValue.length });
  } else {
    // Full extraction
    const meetingSummaries = kgData.map(buildMeetingSummary).join('\n---\n');

    prompt = `You are analyzing a set of meeting records to find contextual relationships between meetings that would NOT be obvious from simple topic name matching.

Look for:
- A decision in one meeting being revisited, overturned, or confirmed in another
- An issue raised in one meeting being escalated or resolved in a later one
- A recurring theme that appears across genuinely separate contexts (not just the same topic name)
- One meeting explicitly referencing outcomes or discussions from another

Here are the meetings:

${meetingSummaries}

Return a JSON array of relationship objects. Each object must have exactly these fields:
- "fromMeetingId": string (the earlier/source meeting ID)
- "toMeetingId": string (the later/target meeting ID)
- "relationshipType": one of "continuation", "resolution", "escalation", "recurring", "reference"
- "sharedThread": string (one sentence describing what connects them)
- "confidence": one of "high", "medium", "low"

Return ONLY the JSON array, no markdown fences, no explanation.
If no relationships are found, return an empty array [].`;
  }

  try {
    const response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACT_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      log.warn('relationship_extraction_api_error', { status: response.status, body: body.slice(0, 200) });
      return [];
    }

    const data = await response.json();
    const rawText =
      data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    const parsed: ExtractedRelationship[] = JSON.parse(rawText);

    // Validate shape
    const validTypes = new Set(['continuation', 'resolution', 'escalation', 'recurring', 'reference']);
    const validConf = new Set(['high', 'medium', 'low']);
    const meetingIds = new Set(kgData.map(m => m.meetingId));

    const validated = parsed.filter(
      r =>
        r.fromMeetingId &&
        r.toMeetingId &&
        meetingIds.has(r.fromMeetingId) &&
        meetingIds.has(r.toMeetingId) &&
        validTypes.has(r.relationshipType) &&
        validConf.has(r.confidence) &&
        typeof r.sharedThread === 'string'
    );

    // Merge: incremental → append new to cached; full → replace entirely
    let merged: ExtractedRelationship[];
    if (canIncremental) {
      const existingPairs = new Set(
        _relCacheValue.map(r => `${r.fromMeetingId}::${r.toMeetingId}`)
      );
      const dedupedNew = validated.filter(
        r => !existingPairs.has(`${r.fromMeetingId}::${r.toMeetingId}`)
      );
      merged = [..._relCacheValue, ...dedupedNew];
    } else {
      merged = validated;
    }

    // Populate cache so subsequent renders skip this API call
    _relCacheKey = fingerprint;
    _relCacheValue = merged;
    saveRelCacheToStorage(fingerprint, merged);
    return merged;
  } catch (err) {
    log.warn('relationship_extraction_failed', { error: err instanceof Error ? err : undefined });
    return [];
  }
}

// ============================================================
// Piece 8 — Meeting edge matrix
// ============================================================

const CONFIDENCE_MULTIPLIER: Record<string, number> = {
  high: 3,
  medium: 1.5,
  low: 0.5,
};

const TYPE_MULTIPLIER: Record<string, number> = {
  continuation: 1.2,
  resolution: 1.0,
  escalation: 0.9,
  recurring: 0.6,
  reference: 0.4,
};

export function buildMeetingEdgeMatrix(
  kgData: MeetingRecord[],
  meetingEmbeddings: Map<string, EmbeddingVector>,
  relationships: ExtractedRelationship[]
): Map<string, MeetingEdge[]> {
  const matrix = new Map<string, MeetingEdge[]>();
  const meetingMap = new Map<string, MeetingRecord>();
  kgData.forEach(m => meetingMap.set(m.meetingId, m));

  // Build bidirectional relationship index
  const relIndex = new Map<string, ExtractedRelationship[]>();
  for (const r of relationships) {
    if (!relIndex.has(r.fromMeetingId)) relIndex.set(r.fromMeetingId, []);
    relIndex.get(r.fromMeetingId)!.push(r);
    if (!relIndex.has(r.toMeetingId)) relIndex.set(r.toMeetingId, []);
    relIndex.get(r.toMeetingId)!.push(r);
  }

  for (let i = 0; i < kgData.length; i++) {
    const a = kgData[i];
    const aKey = `meeting_${a.meetingId}`;
    const aVec = meetingEmbeddings.get(aKey)?.vector;
    const edges: MeetingEdge[] = [];

    for (let j = 0; j < kgData.length; j++) {
      if (i === j) continue;
      const b = kgData[j];
      const bKey = `meeting_${b.meetingId}`;
      const bVec = meetingEmbeddings.get(bKey)?.vector;

      // Embedding score
      const embeddingScore =
        aVec && bVec ? clampedCosine(aVec, bVec) : 0;

      // Contextual score
      const pairRels = (relIndex.get(a.meetingId) || []).filter(
        r =>
          (r.fromMeetingId === a.meetingId && r.toMeetingId === b.meetingId) ||
          (r.fromMeetingId === b.meetingId && r.toMeetingId === a.meetingId)
      );

      let contextualScore = 0;
      for (const r of pairRels) {
        contextualScore +=
          (CONFIDENCE_MULTIPLIER[r.confidence] || 1) *
          (TYPE_MULTIPLIER[r.relationshipType] || 0.5);
      }

      const totalScore = embeddingScore * 5 + contextualScore;

      if (totalScore >= EDGE_MIN_SCORE) {
        edges.push({
          meetingId: b.meetingId,
          meeting: b,
          embeddingScore,
          contextualScore,
          totalScore,
          relationships: pairRels,
        });
      }
    }

    // Sort desc, keep top K
    edges.sort((a, b) => b.totalScore - a.totalScore);
    matrix.set(a.meetingId, edges.slice(0, TOP_K_EDGES));
  }

  return matrix;
}

// ============================================================
// Piece 9 — Graph construction
// ============================================================

// Relationship type → edge color
const REL_TYPE_COLORS: Record<string, string> = {
  continuation: '#3b82f6', // blue
  resolution: '#22c55e',   // green
  escalation: '#ef4444',   // red
  recurring: '#f59e0b',    // amber
  reference: '#8b5cf6',    // purple
};

export function buildGraphData(
  kgData: MeetingRecord[],
  topicEmbeddings: Map<string, EmbeddingVector>,
  meetingEdgeMatrix: Map<string, MeetingEdge[]>,
  relationships: ExtractedRelationship[],
  filterType: string | null
): { nodes: any[]; links: any[] } {
  const nodes: any[] = [];
  const links: any[] = [];
  const canonicalMap: Record<string, CanonicalTopicEntry> = {};

  // ----- Pass 1: build canonical topic map -----
  kgData.forEach(meeting => {
    (meeting.topics || []).forEach(topic => {
      if (!topic || !topic.name) return;
      const embedKey = `topic_${meeting.meetingId}_${topic.name.toLowerCase().replace(/\s+/g, '_')}`;
      const vec = topicEmbeddings.get(embedKey)?.vector || [];
      findCanonicalTopicIdByEmbedding(
        topic,
        vec,
        canonicalMap,
        meeting.meetingDate
      );
    });
  });

  // ----- Pass 2: create nodes and links -----
  kgData.forEach(meeting => {
    const meetingNodeId = `meeting_${meeting.meetingId}`;
    nodes.push({
      id: meetingNodeId,
      label: meeting.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting',
      type: 'meeting',
      data: meeting,
      color: '#141414',
      size: 24,
    });

    (meeting.topics || []).forEach(topic => {
      if (!topic || !topic.name) return;
      const embedKey = `topic_${meeting.meetingId}_${topic.name.toLowerCase().replace(/\s+/g, '_')}`;
      const vec = topicEmbeddings.get(embedKey)?.vector || [];
      const topicId = findCanonicalTopicIdByEmbedding(
        topic,
        vec,
        canonicalMap,
        meeting.meetingDate
      );

      const entry = canonicalMap[topicId];
      if (!nodes.find(n => n.id === topicId)) {
        const statusColor =
          entry.status === 'resolved' ? '#22c55e' :
          entry.status === 'off-track' ? '#ef4444' :
          entry.status === 'revisited' ? '#f59e0b' :
          entry.status === 'ongoing' ? '#3b82f6' : '#8b5cf6';
        nodes.push({
          id: topicId,
          label: entry.label,
          type: 'topic',
          data: {
            ...topic,
            allStatuses: [topic.status],
            allSummaries: [topic.summary],
            occurrences: entry.occurrences,
          },
          color: statusColor,
          size: Math.min(16 + (entry.occurrences - 1) * 4, 28),
        });
      } else {
        const existingNode = nodes.find(n => n.id === topicId);
        if (existingNode?.data) {
          existingNode.data.allStatuses = [
            ...(existingNode.data.allStatuses || []),
            topic.status,
          ];
          existingNode.data.allSummaries = [
            ...(existingNode.data.allSummaries || []),
            topic.summary,
          ];
          existingNode.data.occurrences = entry.occurrences;
          // Escalate color
          if (entry.status === 'off-track') existingNode.color = '#ef4444';
          else if (entry.status === 'revisited' && existingNode.color !== '#ef4444')
            existingNode.color = '#f59e0b';
          existingNode.size = Math.min(16 + (entry.occurrences - 1) * 4, 28);
        }
      }

      links.push({ source: meetingNodeId, target: topicId, type: 'meeting-topic' });
    });

    // Decision nodes
    (meeting.decisions || []).forEach((dec, idx) => {
      if (!dec?.decision) return;
      const decId = `decision_${meeting.meetingId}_${idx}`;
      const decText = String(dec.decision);
      nodes.push({
        id: decId,
        label: decText.length > 40 ? decText.substring(0, 40) + '...' : decText,
        type: 'decision',
        data: { ...dec, meetingId: meeting.meetingId, meetingTitle: meeting.meetingTitle },
        color: '#f59e0b',
        size: 10,
      });

      // Link to canonical topic if possible
      if (dec.relatedTopic) {
        const relEmbedKey = `topic_${meeting.meetingId}_${dec.relatedTopic.toLowerCase().replace(/\s+/g, '_')}`;
        const relVec = topicEmbeddings.get(relEmbedKey)?.vector || [];
        const canonicalId = findCanonicalTopicIdByEmbedding(
          { name: dec.relatedTopic, status: undefined, summary: undefined },
          relVec,
          canonicalMap,
          meeting.meetingDate
        );
        if (nodes.find(n => n.id === canonicalId)) {
          links.push({ source: canonicalId, target: decId, type: 'topic-decision' });
        } else {
          links.push({ source: meetingNodeId, target: decId, type: 'meeting-decision' });
        }
      } else {
        links.push({ source: meetingNodeId, target: decId, type: 'meeting-decision' });
      }
    });

    // People nodes
    (meeting.people || []).forEach(person => {
      if (!person) return;
      const personId = `person_${person.toLowerCase().replace(/\s+/g, '_')}`;
      if (!nodes.find(n => n.id === personId)) {
        nodes.push({
          id: personId,
          label: person,
          type: 'person',
          data: { name: person, meetings: [meeting.meetingTitle] },
          color: '#06b6d4',
          size: 12,
        });
      } else {
        const existingNode = nodes.find(n => n.id === personId);
        if (existingNode?.data) {
          existingNode.data.meetings = [
            ...(existingNode.data.meetings || []),
            meeting.meetingTitle,
          ];
          existingNode.size = Math.min(existingNode.size + 2, 20);
        }
      }
      links.push({ source: meetingNodeId, target: personId, type: 'meeting-person' });
    });

    // Action item nodes
    (meeting.actionItems || []).forEach((item, idx) => {
      if (!item?.task) return;
      const itemId = `action_${meeting.meetingId}_${idx}`;
      const taskText = String(item.task);
      nodes.push({
        id: itemId,
        label: taskText.length > 35 ? taskText.substring(0, 35) + '...' : taskText,
        type: 'action',
        data: { ...item, meetingId: meeting.meetingId, meetingTitle: meeting.meetingTitle },
        color: '#ec4899',
        size: 9,
      });

      if (item.relatedTopic) {
        const relEmbedKey = `topic_${meeting.meetingId}_${item.relatedTopic.toLowerCase().replace(/\s+/g, '_')}`;
        const relVec = topicEmbeddings.get(relEmbedKey)?.vector || [];
        const canonicalId = findCanonicalTopicIdByEmbedding(
          { name: item.relatedTopic, status: undefined, summary: undefined },
          relVec,
          canonicalMap,
          meeting.meetingDate
        );
        if (nodes.find(n => n.id === canonicalId)) {
          links.push({ source: canonicalId, target: itemId, type: 'topic-action' });
        } else {
          links.push({ source: meetingNodeId, target: itemId, type: 'meeting-action' });
        }
      } else {
        links.push({ source: meetingNodeId, target: itemId, type: 'meeting-action' });
      }

      const ownerId = `person_${(item.owner || '').toLowerCase().replace(/\s+/g, '_')}`;
      if (item.owner && nodes.find(n => n.id === ownerId)) {
        links.push({ source: ownerId, target: itemId, type: 'person-action' });
      }
    });
  });

  // ----- Meeting-sibling edges from the edge matrix -----
  const siblingPairsSeen = new Set<string>();

  meetingEdgeMatrix.forEach((edges, meetingId) => {
    // Top 3 edges per the spec (graph clutter prevention)
    const top3 = edges.slice(0, 3);
    for (const edge of top3) {
      const pairKey = [meetingId, edge.meetingId].sort().join('::');
      if (siblingPairsSeen.has(pairKey)) continue;
      siblingPairsSeen.add(pairKey);

      // Find dominant relationship (highest confidence)
      const confOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
      const sortedRels = [...edge.relationships].sort(
        (a, b) => (confOrder[b.confidence] || 0) - (confOrder[a.confidence] || 0)
      );
      const dominant = sortedRels[0] || null;

      const maxScore = TOP_K_EDGES * 5 + 10; // rough upper bound for normalization
      const normalizedScore = Math.min(edge.totalScore / maxScore, 1);
      const opacity = 0.2 + normalizedScore * 0.65; // range [0.2, 0.85]

      links.push({
        source: `meeting_${meetingId}`,
        target: `meeting_${edge.meetingId}`,
        type: 'meeting-sibling',
        weight: edge.totalScore,
        opacity: Math.min(opacity, 0.85),
        color: dominant ? (REL_TYPE_COLORS[dominant.relationshipType] || '#9ca3af') : '#9ca3af',
        label: dominant?.sharedThread || '',
        relationshipType: dominant?.relationshipType || null,
      });
    }
  });

  // ----- Filter pass -----
  let filteredNodes = nodes;
  let filteredLinks = links;

  if (filterType) {
    filteredNodes = nodes.filter(n => n.type === filterType || n.type === 'meeting');
    const nodeIds = new Set(filteredNodes.map(n => n.id));
    filteredLinks = links.filter(l => {
      const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
      const targetId = typeof l.target === 'object' ? l.target.id : l.target;
      return nodeIds.has(sourceId) && nodeIds.has(targetId);
    });
  }

  return { nodes: filteredNodes, links: filteredLinks };
}

// ============================================================
// Piece 10 — Main orchestrator
// ============================================================

export async function buildKnowledgeGraphPipeline(
  kgData: MeetingRecord[],
  onProgress?: (current: number, total: number) => void
): Promise<KGBuildArtifact> {
  const totalStages = 3;

  // Stage 1 — Embed all items
  onProgress?.(1, totalStages);

  const embedItems: Array<{ id: string; text: string }> = [];

  kgData.forEach(meeting => {
    // Whole-meeting embedding
    embedItems.push({
      id: `meeting_${meeting.meetingId}`,
      text: buildMeetingEmbedText(meeting),
    });

    // Per-topic embeddings
    (meeting.topics || []).forEach(topic => {
      if (!topic?.name) return;
      embedItems.push({
        id: `topic_${meeting.meetingId}_${topic.name.toLowerCase().replace(/\s+/g, '_')}`,
        text: buildTopicEmbedText(topic),
      });
    });
  });

  const embeddings = await batchEmbed(embedItems);

  // Stage 2 — Contextual relationship extraction
  onProgress?.(2, totalStages);

  const relationships = await extractContextualRelationships(kgData);

  // Stage 3 — Build edge matrix and graph
  onProgress?.(3, totalStages);

  const meetingEdgeMatrix = buildMeetingEdgeMatrix(
    kgData,
    embeddings,
    relationships
  );

  const { nodes, links } = buildGraphData(
    kgData,
    embeddings,
    meetingEdgeMatrix,
    relationships,
    null // no filter for the initial build
  );

  return {
    nodes,
    links,
    meetingEdgeMatrix,
    embeddings,
    relationships,
  };
}

// ============================================================
// Piece 11 — Runtime helpers
// ============================================================

export function findRelatedMeetings(
  meetingId: string,
  meetingEdgeMatrix: Map<string, MeetingEdge[]>
): MeetingEdge[] {
  return meetingEdgeMatrix.get(meetingId) ?? [];
}

export function searchNodes(query: string, nodes: any[]): any[] {
  if (!query.trim()) return [];
  const lowerQuery = query.toLowerCase();

  const results: any[] = [];
  for (const node of nodes) {
    const labelMatch = node.label?.toLowerCase().includes(lowerQuery);
    const typeMatch = node.type?.toLowerCase().includes(lowerQuery);

    let dataMatch = false;
    if (node.data) {
      if (node.type === 'meeting') {
        dataMatch = (node.data.topics || []).some(
          (t: any) =>
            t.name?.toLowerCase().includes(lowerQuery) ||
            t.summary?.toLowerCase().includes(lowerQuery)
        );
      } else if (node.type === 'topic') {
        dataMatch = !!node.data.summary?.toLowerCase().includes(lowerQuery);
      } else if (node.type === 'decision') {
        dataMatch = !!node.data.decision?.toLowerCase().includes(lowerQuery);
      } else if (node.type === 'action') {
        dataMatch = !!node.data.task?.toLowerCase().includes(lowerQuery);
      }
    }

    if (labelMatch || typeMatch || dataMatch) {
      results.push(node);
    }
    if (results.length >= 10) break;
  }

  return results;
}

const CHAT_CONTEXT_MAX_CHARS = 4000;
const NOTABLE_STATUSES = new Set(['off-track', 'revisited', 'ongoing']);

export function buildChatContext(
  kgData: MeetingRecord[],
  meetingEdgeMatrix: Map<string, MeetingEdge[]>,
  relationships: ExtractedRelationship[]
): string {
  const sections: string[] = [];

  // Recurring topic clusters (compact: just names + count)
  const topicMeetingCount: Record<string, { name: string; count: number }> = {};
  kgData.forEach(m => {
    (m.topics || []).forEach(t => {
      const key = t.name.toLowerCase();
      if (!topicMeetingCount[key]) topicMeetingCount[key] = { name: t.name, count: 0 };
      topicMeetingCount[key].count++;
    });
  });
  const recurring = Object.values(topicMeetingCount).filter(t => t.count > 1);
  if (recurring.length) {
    sections.push(
      `RECURRING: ${recurring.map(t => `${t.name} (×${t.count})`).join(', ')}`
    );
  }

  // Relationships (compact: one line each, skip low-confidence)
  const notableRels = relationships.filter(r => r.confidence !== 'low');
  if (notableRels.length) {
    sections.push(
      `RELATIONSHIPS:\n${notableRels.map(r => `- ${r.relationshipType}: ${r.sharedThread}`).join('\n')}`
    );
  }

  // Open action items (compact)
  const openActions: string[] = [];
  kgData.forEach(m => {
    (m.actionItems || []).forEach(a => {
      openActions.push(`${a.owner}: ${a.task}`);
    });
  });
  if (openActions.length) {
    sections.push(`ACTIONS: ${openActions.join('; ')}`);
  }

  // Per-meeting summaries — compact: full summaries only for notable topics
  const meetingSummaries = kgData.map(m => {
    const topicLine = (m.topics || []).map(t => {
      const isNotable = NOTABLE_STATUSES.has(t.status) ||
        (topicMeetingCount[t.name.toLowerCase()]?.count || 0) > 1;
      return isNotable ? `${t.name} [${t.status}]: ${t.summary}` : `${t.name} [${t.status}]`;
    }).join('; ');
    const parts = [`${m.meetingTitle}: ${topicLine}`];
    if (m.decisions?.length) parts.push(`Decisions: ${m.decisions.map(d => d.decision).join('; ')}`);
    if (m.people?.length) parts.push(`People: ${m.people.join(', ')}`);
    return parts.join(' | ');
  });
  sections.push(`MEETINGS:\n${meetingSummaries.join('\n')}`);

  // Assemble and cap total size
  let context = sections.join('\n\n');
  if (context.length > CHAT_CONTEXT_MAX_CHARS) {
    context = context.substring(0, CHAT_CONTEXT_MAX_CHARS) + '\n[...truncated]';
  }

  return `You are a helpful assistant answering questions about the user's meeting knowledge graph. Use the structured data below. Be concise.

${context}`;
}
