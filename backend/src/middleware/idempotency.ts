import { Request, Response, NextFunction } from "express";
import { BadRequestError } from "../lib/errors";

export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Default window in which the same key returns the cached result. */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h

/** Maximum length accepted for an idempotency key. */
const MAX_KEY_LENGTH = 255;

interface StoredResult {
  statusCode: number;
  body: unknown;
  createdAt: number;
}

/**
 * In-process idempotency store (suitable for single-process deployments).
 * Swap out for a Redis-backed store in multi-replica environments.
 */
export class IdempotencyStore {
  private readonly store = new Map<string, StoredResult>();

  constructor(private readonly windowMs: number = DEFAULT_IDEMPOTENCY_WINDOW_MS) {}

  get(key: string): StoredResult | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.windowMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, statusCode: number, body: unknown): void {
    this.store.set(key, { statusCode, body, createdAt: Date.now() });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all expired entries (call periodically to prevent unbounded growth). */
  purgeExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now - v.createdAt > this.windowMs) {
        this.store.delete(k);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}

/** Singleton store used by the default middleware. */
export const idempotencyStore = new IdempotencyStore();

// Purge expired keys every hour.
setInterval(() => idempotencyStore.purgeExpired(), 60 * 60 * 1000).unref();

/**
 * Express middleware that deduplicates POST requests using an Idempotency-Key header.
 *
 * Contract:
 *  - Clients include `Idempotency-Key: <uuid>` on creation requests.
 *  - If the key was seen within `windowMs`, the original response is returned immediately.
 *  - If the key is absent, the request is passed through unmodified.
 *  - Keys longer than MAX_KEY_LENGTH or containing non-printable characters are rejected 400.
 *
 * @param store   IdempotencyStore instance (defaults to the module-level singleton)
 * @param windowMs Expiry window (defaults to DEFAULT_IDEMPOTENCY_WINDOW_MS)
 */
export function createIdempotencyMiddleware(
  store: IdempotencyStore = idempotencyStore,
) {
  return function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const rawKey = req.headers[IDEMPOTENCY_HEADER];

    // No key → pass through
    if (!rawKey) {
      return next();
    }

    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Validate key
    if (key.length > MAX_KEY_LENGTH || !/^[\x20-\x7E]+$/.test(key)) {
      const err = new BadRequestError(
        `Idempotency-Key must be 1-${MAX_KEY_LENGTH} printable ASCII characters`,
      );
      res.status(err.httpStatus).json(err.toHttpResponse());
      return;
    }

    // Cache hit → replay stored response
    const stored = store.get(key);
    if (stored) {
      res.status(stored.statusCode).json(stored.body);
      return;
    }

    // Intercept res.json to capture the response for future replays
    const originalJson = res.json.bind(res) as (body: unknown) => Response;
    res.json = (body: unknown): Response => {
      // Only cache successful (2xx) responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        store.set(key, res.statusCode, body);
      }
      return originalJson(body);
    };

    next();
  };
}

/** Pre-built middleware instance using the default store and window. */
export const idempotencyMiddleware = createIdempotencyMiddleware();
