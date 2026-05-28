import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";
import {
  IdempotencyStore,
  createIdempotencyMiddleware,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  IDEMPOTENCY_HEADER,
} from "../middleware/idempotency";

function buildApp(store: IdempotencyStore) {
  const app = express();
  app.use(express.json());
  app.use(createIdempotencyMiddleware(store));

  let callCount = 0;
  app.post("/tokens", (_req: Request, res: Response) => {
    callCount++;
    res.status(201).json({ id: `tok-${callCount}`, callCount });
  });

  return { app, getCallCount: () => callCount };
}

describe("IdempotencyStore", () => {
  it("returns undefined for an unseen key", () => {
    const store = new IdempotencyStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("returns the stored result within the window", () => {
    const store = new IdempotencyStore(60_000);
    store.set("k1", 201, { id: "abc" });
    const result = store.get("k1");
    expect(result?.body).toEqual({ id: "abc" });
    expect(result?.statusCode).toBe(201);
  });

  it("returns undefined after the window expires", () => {
    vi.useFakeTimers();
    const store = new IdempotencyStore(1_000);
    store.set("k2", 201, { id: "xyz" });
    vi.advanceTimersByTime(1_001);
    expect(store.get("k2")).toBeUndefined();
    vi.useRealTimers();
  });

  it("purgeExpired removes stale entries", () => {
    vi.useFakeTimers();
    const store = new IdempotencyStore(500);
    store.set("a", 201, {});
    store.set("b", 201, {});
    vi.advanceTimersByTime(600);
    store.purgeExpired();
    expect(store.size).toBe(0);
    vi.useRealTimers();
  });
});

describe("createIdempotencyMiddleware", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore();
  });

  it("passes through requests without an idempotency key", async () => {
    const { app, getCallCount } = buildApp(store);
    await request(app).post("/tokens").send({}).expect(201);
    await request(app).post("/tokens").send({}).expect(201);
    expect(getCallCount()).toBe(2);
  });

  it("returns the original response on a retried key", async () => {
    const { app, getCallCount } = buildApp(store);

    const r1 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "key-001")
      .send({})
      .expect(201);

    const r2 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "key-001")
      .send({})
      .expect(201);

    // Handler only called once
    expect(getCallCount()).toBe(1);
    // Both responses have the same body
    expect(r2.body).toEqual(r1.body);
  });

  it("treats different keys as independent requests", async () => {
    const { app, getCallCount } = buildApp(store);

    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "key-A").send({}).expect(201);
    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "key-B").send({}).expect(201);

    expect(getCallCount()).toBe(2);
  });

  it("rejects a key that is too long", async () => {
    const { app } = buildApp(store);
    const longKey = "x".repeat(256);
    const r = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, longKey)
      .send({});
    expect(r.status).toBe(400);
  });

  it("does not cache error responses", async () => {
    const store2 = new IdempotencyStore();
    const app2 = express();
    app2.use(express.json());
    app2.use(createIdempotencyMiddleware(store2));

    let calls = 0;
    app2.post("/fail-then-succeed", (_req, res) => {
      calls++;
      if (calls === 1) return res.status(500).json({ error: "boom" });
      return res.status(201).json({ id: "ok" });
    });

    await request(app2).post("/fail-then-succeed").set(IDEMPOTENCY_HEADER, "k-err").send({});
    const r2 = await request(app2).post("/fail-then-succeed").set(IDEMPOTENCY_HEADER, "k-err").send({});

    // Second call should have reached the handler (error not cached)
    expect(calls).toBe(2);
    expect(r2.status).toBe(201);
  });

  it("expires stored key after the configured window", async () => {
    vi.useFakeTimers();
    const shortStore = new IdempotencyStore(500);
    const { app, getCallCount } = buildApp(shortStore);

    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "expire-key").send({}).expect(201);

    // Advance past the window
    vi.advanceTimersByTime(600);

    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "expire-key").send({}).expect(201);

    expect(getCallCount()).toBe(2);
    vi.useRealTimers();
  });
});
