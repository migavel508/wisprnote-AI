// ─── Logger Implementation ────────────────────────────────────────────────────
//
// Deep Module: simple interface (info/warn/error/debug/scope) hides all
// complexity — ring buffer, batched transport writes, immediate flush on
// warn/error, context sanitisation, and graceful degradation.
//
// ──────────────────────────────────────────────────────────────────────────────

import type {
  Logger,
  LoggerConfig,
  LogEntry,
  LogLevel,
  LogContext,
  LogTransport,
} from './types';
import { LOG_LEVEL_PRIORITY } from './types';

// ─── Context sanitisation (amendment #2) ─────────────────────────────────────

const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 1024;
const TRUNCATION_SUFFIX = '[TRUNCATED]';

function serializeError(err: Error): Record<string, string> {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack ?? '',
  };
}

/**
 * Sanitise a LogContext before it enters the pipeline.
 * - Serialises Error instances on the `error` key.
 * - Truncates keys longer than 256 chars.
 * - Truncates string values longer than 1024 chars.
 */
export function sanitizeContext(
  raw: LogContext | undefined,
): LogContext | undefined {
  if (!raw) return undefined;

  const clean: Record<string, string | number | boolean | null | undefined | Error | Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key === '__brand') continue;

    // Guard: truncate oversized keys
    const safeKey = key.length > MAX_KEY_LENGTH
      ? key.slice(0, MAX_KEY_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
      : key;

    // Serialise Error objects
    if (key === 'error' && value instanceof Error) {
      clean[safeKey] = serializeError(value);
      continue;
    }

    // Truncate long string values
    if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      clean[safeKey] = value.slice(0, MAX_VALUE_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      continue;
    }

    clean[safeKey] = value;
  }

  return clean;
}

// ─── Ring buffer ─────────────────────────────────────────────────────────────

class RingBuffer {
  private readonly _buf: LogEntry[];
  private readonly _capacity: number;
  private _head = 0;
  private _size = 0;

  constructor(capacity: number) {
    this._capacity = capacity;
    this._buf = new Array(capacity);
  }

  push(entry: LogEntry): void {
    this._buf[this._head] = entry;
    this._head = (this._head + 1) % this._capacity;
    if (this._size < this._capacity) this._size++;
  }

  drain(): LogEntry[] {
    if (this._size === 0) return [];
    const start = (this._head - this._size + this._capacity) % this._capacity;
    const items: LogEntry[] = [];
    for (let i = 0; i < this._size; i++) {
      items.push(this._buf[(start + i) % this._capacity]);
    }
    this._size = 0;
    this._head = 0;
    return items;
  }

  get length(): number {
    return this._size;
  }
}

// ─── Core logger engine (shared by root + scoped instances) ──────────────────

interface LoggerEngine {
  emit(level: LogLevel, module: string, event: string, context?: LogContext): void;
  flush(): Promise<void>;
  destroy(): Promise<void>;
  destroyed: boolean;
}

function createEngine(config: Required<Pick<LoggerConfig, 'minLevel' | 'bufferSize' | 'flushIntervalMs'>> & { transports: LogTransport[] }): LoggerEngine {
  const buffer = new RingBuffer(config.bufferSize);
  let destroyed = false;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  const shouldEmit = (level: LogLevel): boolean =>
    LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[config.minLevel];

  const writeToTransports = async (entries: readonly LogEntry[]): Promise<void> => {
    for (const transport of config.transports) {
      try {
        const filtered = entries.filter(
          (e) => LOG_LEVEL_PRIORITY[e.level] >= LOG_LEVEL_PRIORITY[transport.minLevel],
        );
        if (filtered.length > 0) {
          await transport.write(filtered);
        }
      } catch (err) {
        try {
          console.error(`[Logger] Transport "${transport.name}" write failed:`, err);
        } catch {
          // absolute last resort — swallow silently
        }
      }
    }
  };

  const flushTransports = async (): Promise<void> => {
    for (const transport of config.transports) {
      try {
        await transport.flush?.();
      } catch (err) {
        try {
          console.error(`[Logger] Transport "${transport.name}" flush failed:`, err);
        } catch {
          // swallow
        }
      }
    }
  };

  let flushPromise: Promise<void> | null = null;

  const doFlush = async (force = false): Promise<void> => {
    if (destroyed && !force) return;

    const entries = buffer.drain();
    if (entries.length > 0) {
      await writeToTransports(entries);
    }
    await flushTransports();
  };

  // Start periodic flush — unref() prevents the timer from keeping Node/test processes alive
  flushTimer = setInterval(() => {
    if (destroyed) return;
    void doFlush();
  }, config.flushIntervalMs);
  if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (flushTimer as any).unref();
  }

  const engine: LoggerEngine = {
    get destroyed() {
      return destroyed;
    },

    emit(level: LogLevel, module: string, event: string, context?: LogContext): void {
      if (destroyed) return;
      if (!shouldEmit(level)) return;

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        module,
        event,
        context: sanitizeContext(context),
      };

      buffer.push(entry);

      // Amendment #1: immediate flush on warn or error
      if (level === 'warn' || level === 'error') {
        flushPromise = doFlush();
      }
    },

    async flush(): Promise<void> {
      if (destroyed) return;
      await doFlush();
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;

      if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      // Wait for any in-flight flush
      if (flushPromise) {
        await flushPromise.catch(() => {});
        flushPromise = null;
      }

      // Flush remaining buffered entries (force=true bypasses destroyed check)
      await doFlush(true);

      // Tear down transports
      for (const transport of config.transports) {
        try {
          await transport.destroy?.();
        } catch (err) {
          try {
            console.error(`[Logger] Transport "${transport.name}" destroy failed:`, err);
          } catch {
            // swallow
          }
        }
      }
    },
  };

  return engine;
}

// ─── Logger facade ───────────────────────────────────────────────────────────

function createLoggerFacade(engine: LoggerEngine, module: string): Logger {
  return {
    info(event: string, context?: LogContext): void {
      engine.emit('info', module, event, context);
    },
    warn(event: string, context?: LogContext): void {
      engine.emit('warn', module, event, context);
    },
    error(event: string, context?: LogContext): void {
      engine.emit('error', module, event, context);
    },
    debug(event: string, context?: LogContext): void {
      engine.emit('debug', module, event, context);
    },
    scope(childModule: string): Logger {
      return createLoggerFacade(engine, `${module}.${childModule}`);
    },
    flush(): Promise<void> {
      return engine.flush();
    },
    destroy(): Promise<void> {
      return engine.destroy();
    },
  };
}

// ─── Public factory ──────────────────────────────────────────────────────────

export function createLogger(config: LoggerConfig): Logger {
  const engine = createEngine({
    minLevel: config.minLevel,
    transports: config.transports,
    bufferSize: config.bufferSize ?? 500,
    flushIntervalMs: config.flushIntervalMs ?? 2000,
  });

  const rootModule = config.rootModule ?? 'root';
  return createLoggerFacade(engine, rootModule);
}
