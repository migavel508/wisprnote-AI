// ─── Logger — Public API ──────────────────────────────────────────────────────
//
// Usage:
//   import { logger } from '@/src/lib/logger';
//
//   logger.info('app_started', { version: '1.0.0' });
//   logger.error('fetch_failed', { error: err, endpoint: '/api/data' });
//
//   const kgLog = logger.scope('KnowledgeGraph');
//   kgLog.info('pipeline_started', { meetingCount: 5 });
//
// ──────────────────────────────────────────────────────────────────────────────

export type { Logger, LogEntry, LogLevel, LogContext, LogTransport, LoggerConfig } from './types';
export { LOG_LEVELS, LOG_LEVEL_PRIORITY } from './types';
export { createLogger } from './logger';
export { createConsoleTransport } from './transports/console';
export { createTauriTransport } from './transports/tauri';

// ─── Singleton instance ──────────────────────────────────────────────────────
//
// Pre-configured with:
//   - ConsoleTransport (debug in dev, warn in prod)
//   - TauriTransport (info+ to disk, only when Tauri is available)
//

import { createLogger } from './logger';
import { createConsoleTransport } from './transports/console';
import { createTauriTransport } from './transports/tauri';
import type { LogLevel } from './types';

const env = (() => {
  try { return (import.meta as unknown as Record<string, Record<string, string>>).env ?? {}; }
  catch { return {}; }
})();

const isDev = env.MODE === 'development';

// Force-enable full debug logging in release/build mode when VITE_DEBUG_LOGS is
// set. Release normally suppresses info/debug on the console, which makes it look
// like nothing (e.g. Turbopuffer indexing) is happening even when it is. Set
// VITE_DEBUG_LOGS=true before `tauri build` to see all logs in the packaged app.
const forceDebug = String(env.VITE_DEBUG_LOGS ?? '').toLowerCase() === 'true';
const verbose = isDev || forceDebug;

const globalMinLevel: LogLevel = verbose ? 'debug' : 'info';

export const logger = createLogger({
  minLevel: globalMinLevel,
  rootModule: 'App',
  transports: [
    createConsoleTransport(verbose ? 'debug' : 'warn'),
    createTauriTransport({ minLevel: 'info' }),
  ],
  bufferSize: 500,
  flushIntervalMs: 2000,
});
