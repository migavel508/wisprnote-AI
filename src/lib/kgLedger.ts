// KG extraction ledger — persisted in Supabase `user_ledger_state.kg_extracted_ids` (per user_id).
// Re-exports for backward compatibility; implementation in userLedgerService.

export {
  readKGLedger,
  markKGExtracted,
  markKGExtractedBatch,
  isKGExtracted,
  clearKGLedger,
  reconcileKGLedger,
} from '../services/awsLedgerService';
