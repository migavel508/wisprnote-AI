// ─── Logger Type Definitions ──────────────────────────────────────────────────
//
// Ubiquitous Language:
//   LogEntry    — a single structured log record
//   LogLevel    — severity enum (debug | info | warn | error)
//   LogTransport — a destination that accepts LogEntry batches (console, disk, etc.)
//   LogContext   — structured key-value payload attached to an entry
//   Logger       — the public interface consumers import
//
// Architecture:
//   JS side creates LogEntry → pushes to ring buffer → flush to transports.
//   warn/error entries trigger IMMEDIATE flush (amendment #1).
//   Rust transport writes JSON lines to rotating files via invoke().
//   Console transport pretty-prints in dev.
//
// ──────────────────────────────────────────────────────────────────────────────

// ─── LogLevel ────────────────────────────────────────────────────────────────

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric priority for level filtering. Higher = more severe. */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

// ─── LogContext ──────────────────────────────────────────────────────────────

/**
 * Structured key-value payload attached to a LogEntry.
 *
 * ⚠️  PRIVACY CONSTRAINT — NEVER include:
 *   - Raw transcript text or audio data
 *   - Personally Identifiable Information (PII): names, emails, phone numbers
 *   - API keys, tokens, or credentials
 *   - Meeting content or summaries
 *
 * This type is intentionally a branded Record to mark the boundary.
 * Values must be serializable (string, number, boolean, null, or nested plain objects).
 * Error objects are accepted via the `error` field and serialized specially.
 *
 * If you need to reference user data, log an opaque ID (e.g., meetingId) — never the content.
 */
export type LogContext = {
  /** Optional Error instance — serialized to { name, message, stack } automatically. */
  error?: Error;
} & {
  [key: string]: string | number | boolean | null | undefined | Error | Record<string, unknown>;
} & { readonly __brand?: 'SafeLogContext' };

// ─── LogEntry ────────────────────────────────────────────────────────────────

export interface LogEntry {
  /** ISO-8601 timestamp of when the entry was created. */
  timestamp: string;

  /** Severity level. */
  level: LogLevel;

  /**
   * Module scope that produced this entry.
   * Examples: 'KnowledgeGraph', 'GeminiService', 'App', 'root'.
   */
  module: string;

  /**
   * Machine-readable event name. Use snake_case.
   * Examples: 'pipeline_started', 'embedding_failed', 'cache_hit'.
   */
  event: string;

  /** Optional structured payload. See LogContext privacy constraints. */
  context?: LogContext;
}

// ─── LogTransport ────────────────────────────────────────────────────────────

export interface LogTransport {
  /** Human-readable name for debugging. Example: 'ConsoleTransport', 'RustFileTransport'. */
  readonly name: string;

  /**
   * Minimum level this transport will accept.
   * Entries below this level are silently dropped by the transport.
   */
  minLevel: LogLevel;

  /**
   * Write a batch of entries to the destination.
   * Must not throw — implementations should catch and handle errors internally.
   */
  write(entries: readonly LogEntry[]): void | Promise<void>;

  /**
   * Flush any buffered data. Called on warn/error immediate flush,
   * and when the logger is explicitly flushed (e.g., before app exit).
   */
  flush?(): void | Promise<void>;

  /**
   * Tear down the transport. Called once when the logger is destroyed.
   */
  destroy?(): void | Promise<void>;
}

// ─── Logger Interface ────────────────────────────────────────────────────────

export interface Logger {
  /** Log an informational event. */
  info(event: string, context?: LogContext): void;

  /** Log a warning. Triggers IMMEDIATE flush to all transports. */
  warn(event: string, context?: LogContext): void;

  /** Log an error. Triggers IMMEDIATE flush to all transports. */
  error(event: string, context?: LogContext): void;

  /** Log a debug-level event. Only emitted when minLevel ≤ debug. */
  debug(event: string, context?: LogContext): void;

  /**
   * Create a scoped logger that auto-tags all entries with the given module name.
   * The scoped logger shares the same transports and buffer as the parent.
   */
  scope(module: string): Logger;

  /**
   * Force-flush all buffered entries to every transport.
   * Returns a promise that resolves when all transports have flushed.
   */
  flush(): Promise<void>;

  /**
   * Tear down the logger: flush remaining entries and destroy all transports.
   */
  destroy(): Promise<void>;
}

// ─── LoggerConfig ────────────────────────────────────────────────────────────

export interface LoggerConfig {
  /** Global minimum log level. Entries below this are never created. */
  minLevel: LogLevel;

  /** Module name for the root logger. Defaults to 'root'. */
  rootModule?: string;

  /** Transports to register. At least one is required. */
  transports: LogTransport[];

  /**
   * Maximum number of entries to hold in the ring buffer before
   * the periodic flush cycle pushes them to transports.
   * Default: 500.
   */
  bufferSize?: number;

  /**
   * Interval in milliseconds between periodic buffer flushes.
   * Default: 2000 (2 seconds).
   * Note: warn and error entries bypass this and flush immediately.
   */
  flushIntervalMs?: number;
}
