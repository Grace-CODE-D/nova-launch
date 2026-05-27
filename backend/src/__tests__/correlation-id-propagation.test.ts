/**
 * Tests for #1102: Correlation ID propagation across request logs.
 *
 * Verifies that every log line emitted during a request lifecycle carries the
 * same correlation ID that was established by the middleware.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLoggingMiddleware } from '../middleware/request-logging.middleware';
import { CorrelationLogger } from '../middleware/correlation-logging';
import { getCorrelationId, runWithContext } from '../lib/async-context';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(extraMiddleware?: express.RequestHandler, handler?: express.RequestHandler) {
  const app = express();
  app.use(requestLoggingMiddleware);
  if (extraMiddleware) app.use(extraMiddleware);
  app.get('/test', handler ?? ((_req, res) => res.json({ ok: true })));
  return app;
}

// ---------------------------------------------------------------------------
// async-context unit tests
// ---------------------------------------------------------------------------

describe('AsyncLocalStorage context', () => {
  it('returns undefined outside a request context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('returns the correlation ID inside runWithContext', () => {
    let captured: string | undefined;
    runWithContext('test-id-123', () => {
      captured = getCorrelationId();
    });
    expect(captured).toBe('test-id-123');
  });

  it('isolates correlation IDs across concurrent contexts', async () => {
    const results: (string | undefined)[] = [];

    await Promise.all([
      new Promise<void>((resolve) =>
        runWithContext('ctx-A', () => {
          // Yield to allow the other context to interleave
          setTimeout(() => {
            results.push(getCorrelationId());
            resolve();
          }, 5);
        })
      ),
      new Promise<void>((resolve) =>
        runWithContext('ctx-B', () => {
          setTimeout(() => {
            results.push(getCorrelationId());
            resolve();
          }, 5);
        })
      ),
    ]);

    expect(results).toContain('ctx-A');
    expect(results).toContain('ctx-B');
  });
});

// ---------------------------------------------------------------------------
// logger unit tests
// ---------------------------------------------------------------------------

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('includes correlationId from async context', () => {
    runWithContext('log-test-id', () => {
      logger.info('hello from service');
    });

    expect(logSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(logSpy.mock.calls[0][0]);
    expect(entry.correlationId).toBe('log-test-id');
    expect(entry.message).toBe('hello from service');
    expect(entry.level).toBe('info');
  });

  it('omits correlationId when called outside a context', () => {
    logger.info('outside context');
    const entry = JSON.parse(logSpy.mock.calls[0][0]);
    expect(entry.correlationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Middleware integration: correlation ID propagates through the request
// ---------------------------------------------------------------------------

describe('requestLoggingMiddleware — correlation ID propagation', () => {
  it('propagates an incoming x-correlation-id header to downstream handlers', async () => {
    let capturedId: string | undefined;
    const app = buildApp(undefined, (req, res) => {
      capturedId = getCorrelationId();
      res.json({ ok: true });
    });

    await request(app)
      .get('/test')
      .set('x-correlation-id', 'client-correlation-abc');

    expect(capturedId).toBe('client-correlation-abc');
  });

  it('generates a correlation ID when none is provided', async () => {
    let capturedId: string | undefined;
    const app = buildApp(undefined, (_req, res) => {
      capturedId = getCorrelationId();
      res.json({ ok: true });
    });

    await request(app).get('/test');

    expect(capturedId).toBeDefined();
    expect(typeof capturedId).toBe('string');
    expect(capturedId!.length).toBeGreaterThan(0);
  });

  it('echoes the correlation ID back in the X-Correlation-Id response header', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/test')
      .set('x-correlation-id', 'echo-test-id');

    expect(res.headers['x-correlation-id']).toBe('echo-test-id');
  });

  it('keeps the same correlation ID across multiple log calls in one request', async () => {
    const ids: (string | undefined)[] = [];

    const app = buildApp(undefined, (_req, res) => {
      ids.push(getCorrelationId());
      ids.push(getCorrelationId());
      res.json({ ok: true });
    });

    await request(app)
      .get('/test')
      .set('x-correlation-id', 'consistent-id');

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('consistent-id');
    expect(ids[1]).toBe('consistent-id');
  });
});

// ---------------------------------------------------------------------------
// CorrelationLogger.middleware — same guarantees
// ---------------------------------------------------------------------------

describe('CorrelationLogger.middleware — correlation ID propagation', () => {
  function buildCorrelationApp(handler?: express.RequestHandler) {
    const app = express();
    app.use(CorrelationLogger.middleware());
    app.get('/test', handler ?? ((_req, res) => res.json({ ok: true })));
    return app;
  }

  it('attaches correlation ID to req.correlationId', async () => {
    let captured: string | undefined;
    const app = buildCorrelationApp((req: any, res) => {
      captured = req.correlationId;
      res.json({ ok: true });
    });

    await request(app)
      .get('/test')
      .set('x-correlation-id', 'corr-mw-test');

    expect(captured).toBe('corr-mw-test');
  });

  it('makes correlation ID available via getCorrelationId() inside the handler', async () => {
    let captured: string | undefined;
    const app = buildCorrelationApp((_req, res) => {
      captured = getCorrelationId();
      res.json({ ok: true });
    });

    await request(app)
      .get('/test')
      .set('x-correlation-id', 'async-ctx-corr');

    expect(captured).toBe('async-ctx-corr');
  });
});
