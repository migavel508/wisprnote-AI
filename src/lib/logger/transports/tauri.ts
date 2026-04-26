// ─── Tauri File Transport ──────────────────────────────────────────────────────
//
// Sends batched LogEntries to the Rust backend via Tauri's invoke().
// The Rust side writes JSON lines to rotating files in appDataDir.
//
// Graceful degradation: if invoke() is unavailable (e.g., running in browser
// during dev without Tauri), this transport silently becomes a no-op.
//
// ──────────────────────────────────────────────────────────────────────────────

import type { LogEntry, LogLevel, LogTransport } from '../types';

/** Serialisable shape sent to Rust — no Error objects, pure JSON. */
interface SerializedLogEntry {
  timestamp: string;
  level: string;
  module: string;
  event: string;
  context?: Record<string, unknown>;
}

function serialize(entry: LogEntry): SerializedLogEntry {
  return {
    timestamp: entry.timestamp,
    level: entry.level,
    module: entry.module,
    event: entry.event,
    context: entry.context as Record<string, unknown> | undefined,
  };
}

/** Check if Tauri invoke is available at runtime. */
function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  try {
    // Tauri v2 API
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      // Dynamic import to avoid bundler issues when Tauri isn't present
      return (window as Record<string, unknown>).__TAURI_INTERNALS__
        ? async (cmd: string, args?: Record<string, unknown>) => {
            const { invoke } = await import('@tauri-apps/api/core');
            return invoke(cmd, args);
          }
        : null;
    }
  } catch {
    // Not in Tauri context
  }
  return null;
}

export interface TauriTransportConfig {
  /** Minimum log level for this transport. Default: 'info'. */
  minLevel?: LogLevel;
  /** Tauri command name registered on the Rust side. Default: 'write_logs'. */
  commandName?: string;
}

export function createTauriTransport(config: TauriTransportConfig = {}): LogTransport {
  const commandName = config.commandName ?? 'write_logs';
  let invoke = getTauriInvoke();
  let available = invoke !== null;
  let warnedUnavailable = false;

  return {
    name: 'TauriFileTransport',
    minLevel: config.minLevel ?? 'info',

    async write(entries: readonly LogEntry[]): Promise<void> {
      // Lazy re-check: Tauri might become available after initial load
      if (!available) {
        invoke = getTauriInvoke();
        available = invoke !== null;
      }

      if (!invoke) {
        if (!warnedUnavailable) {
          console.debug('[TauriFileTransport] Tauri invoke unavailable — falling back to console-only logging.');
          warnedUnavailable = true;
        }
        return;
      }

      try {
        const serialized = entries.map(serialize);
        await invoke(commandName, { entries: serialized });
      } catch (err) {
        console.error(`[TauriFileTransport] Failed to send ${entries.length} entries to Rust:`, err);
      }
    },

    async flush(): Promise<void> {
      // Rust side handles its own file flushing
    },

    async destroy(): Promise<void> {
      // Nothing to tear down — Rust owns the file handle
    },
  };
}
