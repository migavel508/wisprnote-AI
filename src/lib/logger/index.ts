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

const isDev = (() => {
  try {
    // Vite injects import.meta.env at build time
    return (import.meta as unknown as Record<string, Record<string, string>>).env?.MODE === 'development';
  } catch {
    return false;
  }
})();

const globalMinLevel: LogLevel = isDev ? 'debug' : 'info';

export const logger = createLogger({
  minLevel: globalMinLevel,
  rootModule: 'App',
  transports: [
    createConsoleTransport(isDev ? 'debug' : 'warn'),
    createTauriTransport({ minLevel: 'info' }),
  ],
  bufferSize: 500,
  flushIntervalMs: 2000,
});
