// ─── Logger Test Suite ────────────────────────────────────────────────────────
//
// Run: npx vitest run src/lib/logger/logger.test.ts
// ──────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LogEntry, LogTransport, LogLevel, Logger } from './types';
import { LOG_LEVEL_PRIORITY } from './types';
import { createLogger, sanitizeContext } from './logger';

// ── Mock transport factory ───────────────────────────────────────────────────

function createMockTransport(minLevel: LogLevel = 'debug'): LogTransport & {
  written: LogEntry[];
  flushCount: number;
  destroyCount: number;
} {
  const transport = {
    name: 'MockTransport',
    minLevel,
    written: [] as LogEntry[],
    flushCount: 0,
    destroyCount: 0,
    write: vi.fn((entries: readonly LogEntry[]) => {
      transport.written.push(...entries);
    }),
    flush: vi.fn(() => {
      transport.flushCount++;
    }),
    destroy: vi.fn(() => {
      transport.destroyCount++;
    }),
  };
  return transport;
}

// Helper: wait for microtasks/promises to settle
const tick = () => new Promise<void>((r) => setTimeout(r, 50));

// ─── Type-level tests ────────────────────────────────────────────────────────

describe('LogLevel priority', () => {
  it('should rank debug < info < warn < error', () => {
    expect(LOG_LEVEL_PRIORITY.debug).toBeLessThan(LOG_LEVEL_PRIORITY.info);
    expect(LOG_LEVEL_PRIORITY.info).toBeLessThan(LOG_LEVEL_PRIORITY.warn);
    expect(LOG_LEVEL_PRIORITY.warn).toBeLessThan(LOG_LEVEL_PRIORITY.error);
  });
});

// ─── Logger creation ─────────────────────────────────────────────────────────

describe('createLogger', () => {
  let logger: Logger;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    transport = createMockTransport();
    logger = createLogger({
      minLevel: 'debug',
      transports: [transport],
      bufferSize: 500,
      flushIntervalMs: 60_000, // large so periodic flush doesn't interfere
    });
  });

  afterEach(async () => {
    await logger.destroy();
  });

  it('should create a logger with the given config', () => {
    expect(logger).toBeDefined();
  });

  it('should expose info, warn, error, debug, scope, flush, destroy methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.scope).toBe('function');
    expect(typeof logger.flush).toBe('function');
    expect(typeof logger.destroy).toBe('function');
  });
});

// ─── Entry creation ──────────────────────────────────────────────────────────

describe('LogEntry creation', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let logger: Logger;

  beforeEach(() => {
    transport = createMockTransport();
    logger = createLogger({
      minLevel: 'debug',
      transports: [transport],
      bufferSize: 500,
      flushIntervalMs: 60_000,
    });
  });

  afterEach(async () => { await logger.destroy(); });

  it('logger.info should create an entry with level "info"', async () => {
    logger.info('test_event');
    await logger.flush();
    await tick();
    expect(transport.written.some((e) => e.level === 'info')).toBe(true);
  });

  it('logger.warn should create an entry with level "warn"', async () => {
    logger.warn('test_event');
    await tick();
    expect(transport.written.some((e) => e.level === 'warn')).toBe(true);
  });

  it('logger.error should create an entry with level "error"', async () => {
    logger.error('test_event');
    await tick();
    expect(transport.written.some((e) => e.level === 'error')).toBe(true);
  });

  it('logger.debug should create an entry with level "debug"', async () => {
    logger.debug('test_event');
    await logger.flush();
    await tick();
    expect(transport.written.some((e) => e.level === 'debug')).toBe(true);
  });

  it('each entry should have an ISO-8601 timestamp', async () => {
    logger.info('ts_check');
    await logger.flush();
    await tick();
    const entry = transport.written[0];
    expect(entry.timestamp).toBeDefined();
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it('each entry should include the module name', async () => {
    logger.info('mod_check');
    await logger.flush();
    await tick();
    expect(transport.written[0].module).toBe('root');
  });

  it('each entry should include the event string', async () => {
    logger.info('my_event');
    await logger.flush();
    await tick();
    expect(transport.written[0].event).toBe('my_event');
  });

  it('context should be optional — entries work without it', async () => {
    logger.info('no_ctx');
    await logger.flush();
    await tick();
    expect(transport.written[0].event).toBe('no_ctx');
    // context can be undefined
    expect(transport.written[0].context === undefined || typeof transport.written[0].context === 'object').toBe(true);
  });

  it('context with an Error should serialize error to { name, message, stack }', async () => {
    const err = new Error('boom');
    logger.error('with_err', { error: err });
    await tick();
    const entry = transport.written[0];
    const serialized = entry.context?.error as unknown as Record<string, string>;
    expect(serialized).toBeDefined();
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(typeof serialized.stack).toBe('string');
  });
});

// ─── Level filtering ─────────────────────────────────────────────────────────

describe('Level filtering', () => {
  it('logger with minLevel "info" should drop debug entries', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'info', transports: [t], flushIntervalMs: 60_000 });
    log.debug('should_be_dropped');
    await log.flush();
    await tick();
    expect(t.written.length).toBe(0);
    await log.destroy();
  });

  it('logger with minLevel "warn" should drop debug and info entries', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'warn', transports: [t], flushIntervalMs: 60_000 });
    log.debug('dropped');
    log.info('dropped');
    await log.flush();
    await tick();
    expect(t.written.length).toBe(0);
    await log.destroy();
  });

  it('logger with minLevel "error" should only emit error entries', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'error', transports: [t], flushIntervalMs: 60_000 });
    log.debug('no');
    log.info('no');
    log.warn('no');
    log.error('yes');
    await tick();
    expect(t.written.length).toBe(1);
    expect(t.written[0].level).toBe('error');
    await log.destroy();
  });

  it('transport with minLevel "warn" should not receive info entries even if logger minLevel is "debug"', async () => {
    const t = createMockTransport('warn');
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.info('should_be_filtered_by_transport');
    await log.flush();
    await tick();
    expect(t.written.length).toBe(0);
    await log.destroy();
  });
});

// ─── Buffering and flush ─────────────────────────────────────────────────────

describe('Ring buffer and periodic flush', () => {
  it('info entries should be buffered, not immediately written to transport', () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.info('buffered');
    // Synchronously, nothing should be written yet (info is buffered)
    expect(t.write).not.toHaveBeenCalled();
    void log.destroy();
  });

  it('debug entries should be buffered, not immediately written to transport', () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.debug('buffered');
    expect(t.write).not.toHaveBeenCalled();
    void log.destroy();
  });

  it('buffered entries should flush after flushIntervalMs', async () => {
    vi.useFakeTimers();
    try {
      const t = createMockTransport();
      const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 100 });
      log.info('will_flush');
      expect(t.written.length).toBe(0);
      // Advance just past the flush interval — avoids infinite loop from setInterval
      await vi.advanceTimersByTimeAsync(150);
      expect(t.written.length).toBe(1);
      expect(t.written[0].event).toBe('will_flush');
      // Restore real timers BEFORE destroy so async operations resolve
      vi.useRealTimers();
      await log.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffer should not exceed bufferSize — oldest entries dropped when full', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], bufferSize: 3, flushIntervalMs: 60_000 });
    log.info('a');
    log.info('b');
    log.info('c');
    log.info('d'); // pushes 'a' out of ring buffer
    await log.flush();
    await tick();
    // Should only have the 3 most recent: b, c, d
    expect(t.written.length).toBe(3);
    expect(t.written.map((e) => e.event)).toEqual(['b', 'c', 'd']);
    await log.destroy();
  });

  it('explicit flush() should push all buffered entries to transports', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.info('one');
    log.info('two');
    expect(t.written.length).toBe(0);
    await log.flush();
    await tick();
    expect(t.written.length).toBe(2);
    await log.destroy();
  });
});

// ─── Immediate flush on warn/error ───────────────────────────────────────────

describe('Immediate flush (amendment #1)', () => {
  it('warn should trigger immediate flush of ALL buffered entries plus the warn entry', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.info('before');
    log.warn('trigger');
    await tick();
    // Both the buffered info AND the warn should have flushed
    expect(t.written.length).toBe(2);
    expect(t.written[0].event).toBe('before');
    expect(t.written[1].event).toBe('trigger');
    expect(t.written[1].level).toBe('warn');
    await log.destroy();
  });

  it('error should trigger immediate flush of ALL buffered entries plus the error entry', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.info('before');
    log.error('trigger');
    await tick();
    expect(t.written.length).toBe(2);
    expect(t.written[0].event).toBe('before');
    expect(t.written[1].level).toBe('error');
    await log.destroy();
  });

  it('immediate flush should call transport.flush() after write', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.warn('trigger');
    await tick();
    expect(t.flush).toHaveBeenCalled();
    expect(t.flushCount).toBeGreaterThanOrEqual(1);
    await log.destroy();
  });
});

// ─── Scoped logger ───────────────────────────────────────────────────────────

describe('Scoped logger', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let logger: Logger;

  beforeEach(() => {
    transport = createMockTransport();
    logger = createLogger({ minLevel: 'debug', transports: [transport], flushIntervalMs: 60_000 });
  });
  afterEach(async () => { await logger.destroy(); });

  it('scope() should return a Logger instance', () => {
    const scoped = logger.scope('Test');
    expect(typeof scoped.info).toBe('function');
    expect(typeof scoped.warn).toBe('function');
    expect(typeof scoped.error).toBe('function');
    expect(typeof scoped.debug).toBe('function');
    expect(typeof scoped.scope).toBe('function');
    expect(typeof scoped.flush).toBe('function');
    expect(typeof scoped.destroy).toBe('function');
  });

  it('scoped logger entries should have the scoped module name', async () => {
    const scoped = logger.scope('KnowledgeGraph');
    scoped.info('test');
    await logger.flush();
    await tick();
    expect(transport.written[0].module).toBe('root.KnowledgeGraph');
  });

  it('scoped logger should share the same buffer as root', async () => {
    const scoped = logger.scope('A');
    logger.info('root_entry');
    scoped.info('scoped_entry');
    await logger.flush();
    await tick();
    // Both entries go through the same transport
    expect(transport.written.length).toBe(2);
  });

  it('scoped logger should share the same transports as root', async () => {
    const scoped = logger.scope('A');
    scoped.warn('check');
    await tick();
    // warn triggers immediate flush; the mock transport should have it
    expect(transport.written.length).toBe(1);
    expect(transport.written[0].module).toBe('root.A');
  });

  it('nested scope (scope("A").scope("B")) should produce module "A.B"', async () => {
    const nested = logger.scope('A').scope('B');
    nested.info('deep');
    await logger.flush();
    await tick();
    expect(transport.written[0].module).toBe('root.A.B');
  });
});

// ─── Multiple transports ────────────────────────────────────────────────────

describe('Multiple transports', () => {
  it('entries should be written to all registered transports', async () => {
    const t1 = createMockTransport();
    const t2 = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t1, t2], flushIntervalMs: 60_000 });
    log.info('fanout');
    await log.flush();
    await tick();
    expect(t1.written.length).toBe(1);
    expect(t2.written.length).toBe(1);
    await log.destroy();
  });

  it('each transport respects its own minLevel independently', async () => {
    const tDebug = createMockTransport('debug');
    const tWarn = createMockTransport('warn');
    const log = createLogger({ minLevel: 'debug', transports: [tDebug, tWarn], flushIntervalMs: 60_000 });
    log.info('info_msg');
    await log.flush();
    await tick();
    expect(tDebug.written.length).toBe(1); // debug transport accepts info
    expect(tWarn.written.length).toBe(0);  // warn transport rejects info
    await log.destroy();
  });

  it('if one transport.write throws, other transports still receive entries', async () => {
    const tBroken: LogTransport = {
      name: 'BrokenTransport',
      minLevel: 'debug',
      write: vi.fn(() => { throw new Error('transport exploded'); }),
    };
    const tGood = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [tBroken, tGood], flushIntervalMs: 60_000 });
    log.info('survive');
    await log.flush();
    await tick();
    expect(tGood.written.length).toBe(1);
    expect(tGood.written[0].event).toBe('survive');
    await log.destroy();
  });
});

// ─── Graceful degradation ────────────────────────────────────────────────────

describe('Graceful degradation', () => {
  it('if transport.write rejects, logger should not throw', async () => {
    const tFailing: LogTransport = {
      name: 'FailTransport',
      minLevel: 'debug',
      write: vi.fn(() => Promise.reject(new Error('network down'))),
    };
    const log = createLogger({ minLevel: 'debug', transports: [tFailing], flushIntervalMs: 60_000 });
    // This must NOT throw
    log.warn('survive');
    await tick();
    await log.destroy();
  });

  it('if transport.write rejects, logger should console.error a warning', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tFailing: LogTransport = {
      name: 'FailTransport',
      minLevel: 'debug',
      write: vi.fn(() => Promise.reject(new Error('disk full'))),
    };
    const log = createLogger({ minLevel: 'debug', transports: [tFailing], flushIntervalMs: 60_000 });
    log.warn('check');
    await tick();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('FailTransport'),
      expect.anything(),
    );
    consoleSpy.mockRestore();
    await log.destroy();
  });

  it('if all transports fail, entries are dropped without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t1: LogTransport = {
      name: 'Fail1',
      minLevel: 'debug',
      write: vi.fn(() => { throw new Error('nope'); }),
    };
    const t2: LogTransport = {
      name: 'Fail2',
      minLevel: 'debug',
      write: vi.fn(() => { throw new Error('nope'); }),
    };
    const log = createLogger({ minLevel: 'debug', transports: [t1, t2], flushIntervalMs: 60_000 });
    log.error('total_failure');
    await tick();
    // No crash — just console.error calls
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    await log.destroy();
  });
});

// ─── Destroy lifecycle ───────────────────────────────────────────────────────

describe('Destroy lifecycle', () => {
  it('destroy() should flush remaining buffer entries', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    log.info('before_destroy');
    await log.destroy();
    await tick();
    expect(t.written.length).toBe(1);
    expect(t.written[0].event).toBe('before_destroy');
  });

  it('destroy() should call destroy() on each transport', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    await log.destroy();
    expect(t.destroy).toHaveBeenCalled();
    expect(t.destroyCount).toBe(1);
  });

  it('after destroy(), calling log methods should be a no-op (no throw)', async () => {
    const t = createMockTransport();
    const log = createLogger({ minLevel: 'debug', transports: [t], flushIntervalMs: 60_000 });
    await log.destroy();
    // These must not throw
    log.info('noop');
    log.warn('noop');
    log.error('noop');
    log.debug('noop');
    await tick();
    // Nothing new should be written after the initial destroy flush
    const countAfterDestroy = t.written.length;
    log.info('extra');
    await tick();
    expect(t.written.length).toBe(countAfterDestroy);
  });
});

// ─── LogContext safety (amendment #2) ────────────────────────────────────────

describe('LogContext safety boundary', () => {
  it('context values should be serializable (string, number, boolean, null)', () => {
    const result = sanitizeContext({ count: 42, label: 'test', flag: true, empty: null });
    expect(result).toEqual({ count: 42, label: 'test', flag: true, empty: null });
  });

  it('Error in context.error should be serialized to { name, message, stack }', () => {
    const err = new Error('test_error');
    err.name = 'CustomError';
    const result = sanitizeContext({ error: err });
    const serialized = result?.error as unknown as Record<string, string>;
    expect(serialized.name).toBe('CustomError');
    expect(serialized.message).toBe('test_error');
    expect(typeof serialized.stack).toBe('string');
  });

  it('context should not contain keys longer than 256 characters (guard against transcript leaks)', () => {
    const longKey = 'x'.repeat(300);
    const result = sanitizeContext({ [longKey]: 'val' });
    const keys = Object.keys(result!);
    expect(keys.every((k) => k.length <= 256)).toBe(true);
    expect(keys[0].endsWith('[TRUNCATED]')).toBe(true);
  });

  it('context string values longer than 1024 characters should be truncated with "[TRUNCATED]" suffix', () => {
    const longVal = 'y'.repeat(2000);
    const result = sanitizeContext({ data: longVal });
    const val = result?.data as string;
    expect(val.length).toBeLessThanOrEqual(1024);
    expect(val.endsWith('[TRUNCATED]')).toBe(true);
  });
});
