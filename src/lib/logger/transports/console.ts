// ─── Console Transport ─────────────────────────────────────────────────────────
//
// Pretty-prints LogEntries to the browser/Node console with color-coded levels.
// Used in development. In production, set minLevel to 'warn' or above.
//
// ──────────────────────────────────────────────────────────────────────────────

import type { LogEntry, LogLevel, LogTransport } from '../types';

const LEVEL_STYLES: Record<LogLevel, { badge: string; css: string }> = {
  debug: { badge: 'DBG', css: 'color:#888;font-weight:normal' },
  info:  { badge: 'INF', css: 'color:#2563eb;font-weight:bold' },
  warn:  { badge: 'WRN', css: 'color:#d97706;font-weight:bold' },
  error: { badge: 'ERR', css: 'color:#dc2626;font-weight:bold' },
};

export function createConsoleTransport(minLevel: LogLevel = 'debug'): LogTransport {
  return {
    name: 'ConsoleTransport',
    minLevel,

    write(entries: readonly LogEntry[]): void {
      for (const entry of entries) {
        const { badge, css } = LEVEL_STYLES[entry.level];
        const ts = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
        const prefix = `%c${badge}%c [${ts}] [${entry.module}]`;
        const args: unknown[] = [prefix, css, 'color:inherit', entry.event];

        if (entry.context && Object.keys(entry.context).length > 0) {
          args.push(entry.context);
        }

        switch (entry.level) {
          case 'error':
            console.error(...args);
            break;
          case 'warn':
            console.warn(...args);
            break;
          case 'debug':
            console.debug(...args);
            break;
          default:
            console.log(...args);
        }
      }
    },
  };
}
