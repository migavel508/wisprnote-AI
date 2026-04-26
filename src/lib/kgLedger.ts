// ─── KG Extraction Ledger ────────────────────────────────────────────────────
//
// Mirrors Turbopuffer's backfill ledger pattern. Tracks which meeting IDs have
// already had their Knowledge Graph extracted and persisted to Supabase.
//
// On auto-sync / rebuild the ledger is checked *first* — if the meeting is
// already known, we skip the Supabase diff and Gemini extraction entirely.
//
// ──────────────────────────────────────────────────────────────────────────────

const KG_LEDGER_KEY = 'kg_extracted_meetings';

export function readKGLedger(): Set<string> {
  try {
    const raw = localStorage.getItem(KG_LEDGER_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function markKGExtracted(meetingId: string): void {
  const ids = readKGLedger();
  ids.add(meetingId);
  writeKGLedger(ids);
}

export function markKGExtractedBatch(meetingIds: string[]): void {
  const ids = readKGLedger();
  for (const id of meetingIds) ids.add(id);
  writeKGLedger(ids);
}

export function isKGExtracted(meetingId: string): boolean {
  return readKGLedger().has(meetingId);
}

export function clearKGLedger(): void {
  localStorage.removeItem(KG_LEDGER_KEY);
}

/** Reconcile: remove IDs from ledger that no longer exist in Supabase KG data. */
export function reconcileKGLedger(supabaseKGIds: Set<string>): void {
  const ledger = readKGLedger();
  let changed = false;
  for (const id of ledger) {
    if (!supabaseKGIds.has(id)) {
      ledger.delete(id);
      changed = true;
    }
  }
  if (changed) writeKGLedger(ledger);
}

function writeKGLedger(ids: Set<string>): void {
  try {
    localStorage.setItem(KG_LEDGER_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* storage full — non-critical */ }
}
