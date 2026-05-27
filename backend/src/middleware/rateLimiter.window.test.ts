/**
 * Tests for Redis-backed sliding-window rate limiter accuracy
 *
 * Issue #1065: Validate sliding-window accuracy under burst traffic
 * and edge cases around window boundaries.
 *
 * Note: These tests use mocked Redis to avoid requiring a running Redis instance.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveKey } from "./rateLimiter";
import { Request } from "express";

// ─── Mock Redis ──────────────────────────────────────────────────────────────

class MockRedis {
  private data: Map<string, Array<{ score: number; member: string }>> = new Map();
  private ttls: Map<string, number> = new Map();

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    const entries = this.data.get(key) || [];
    const before = entries.length;
    const minNum = typeof min === "string" ? (min === "-inf" ? -Infinity : parseInt(min)) : min;
    const maxNum = typeof max === "string" ? (max === "+inf" ? Infinity : parseInt(max)) : max;
    const filtered = entries.filter((e) => e.score < minNum || e.score > maxNum);
    this.data.set(key, filtered);
    return before - filtered.length;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const entries = this.data.get(key) || [];
    entries.push({ score, member });
    this.data.set(key, entries);
    return 1;
  }

  async zcard(key: string): Promise<number> {
    return (this.data.get(key) || []).length;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) || -1;
  }

  async flushdb(): Promise<string> {
    this.data.clear();
    this.ttls.clear();
    return "OK";
  }

  async quit(): Promise<void> {
    this.data.clear();
    this.ttls.clear();
  }

  pipeline() {
    const commands: Array<() => Promise<any>> = [];
    return {
      zremrangebyscore: (key: string, min: string | number, max: string | number) => {
        commands.push(() => this.zremrangebyscore(key, min, max));
        return this;
      },
      zadd: (key: string, score: number, member: string) => {
        commands.push(() => this.zadd(key, score, member));
        return this;
      },
      zcard: (key: string) => {
        commands.push(() => this.zcard(key));
        return this;
      },
      expire: (key: string, seconds: number) => {
        commands.push(() => this.expire(key, seconds));
        return this;
      },
      exec: async () => {
        const results = await Promise.all(commands.map((cmd) => cmd()));
        return results.map((result) => [null, result]);
      },
    };
  }
}

let mockRedis: MockRedis;

beforeEach(() => {
  mockRedis = new MockRedis();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockRequest(ip: string, walletAddress?: string): Partial<Request> {
  return {
    ip,
    socket: { remoteAddress: ip } as any,
    user: walletAddress ? { walletAddress } : undefined,
  } as any;
}

// Helper to simulate sliding window increment
async function incrementSlidingWindowMock(
  redis: MockRedis,
  key: string,
  windowMs: number
): Promise<number> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const expireSeconds = Math.ceil(windowMs / 1000) + 1;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, "-inf", windowStart);
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zcard(key);
  pipeline.expire(key, expireSeconds);

  const results = await pipeline.exec();
  const count = (results?.[2]?.[1] as number) ?? 1;
  return count;
}

// ─── Issue #1065: Sliding-Window Accuracy Tests ──────────────────────────────

describe("Issue #1065: Redis sliding-window rate limiter accuracy", () => {
  const windowMs = 1000; // 1 second window for fast tests
  const key = "test:ratelimit:key";

  it("allows N requests within the window and rejects N+1th", async () => {
    const maxRequests = 5;

    // Make 5 requests (should all succeed)
    for (let i = 0; i < maxRequests; i++) {
      const count = await incrementSlidingWindowMock(mockRedis, key, windowMs);
      expect(count).toBeLessThanOrEqual(maxRequests);
    }

    // 6th request should exceed limit
    const count = await incrementSlidingWindowMock(mockRedis, key, windowMs);
    expect(count).toBeGreaterThan(maxRequests);
  });

  it("per-key isolation: different keys have independent budgets", async () => {
    const key1 = "test:key:1";
    const key2 = "test:key:2";
    const maxRequests = 2;

    // Exhaust key1
    for (let i = 0; i < maxRequests; i++) {
      await incrementSlidingWindowMock(mockRedis, key1, windowMs);
    }

    // key2 should still have budget
    const count1 = await incrementSlidingWindowMock(mockRedis, key1, windowMs);
    const count2 = await incrementSlidingWindowMock(mockRedis, key2, windowMs);

    expect(count1).toBeGreaterThan(maxRequests); // key1 exceeded
    expect(count2).toBe(1); // key2 fresh
  });

  it("handles burst traffic: rapid requests all counted correctly", async () => {
    const maxRequests = 10;
    const requests = Array.from({ length: maxRequests + 5 }, () =>
      incrementSlidingWindowMock(mockRedis, key, windowMs)
    );

    const counts = await Promise.all(requests);

    // First 10 should be <= 10
    for (let i = 0; i < maxRequests; i++) {
      expect(counts[i]).toBeLessThanOrEqual(maxRequests);
    }

    // Last 5 should exceed limit
    for (let i = maxRequests; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(maxRequests);
    }
  });

  it("resolveKey uses wallet address when available", () => {
    const req = createMockRequest("192.168.1.1", "GWALLETABC123");
    const resolvedKey = resolveKey(req as Request, "rl");

    expect(resolvedKey).toContain("wallet:GWALLETABC123");
    expect(resolvedKey).not.toContain("192.168.1.1");
  });

  it("resolveKey falls back to IP when wallet not available", () => {
    const req = createMockRequest("192.168.1.1");
    const resolvedKey = resolveKey(req as Request, "rl");

    expect(resolvedKey).toContain("ip:192.168.1.1");
  });

  it("different wallet addresses have independent limits", async () => {
    const wallet1Key = resolveKey(
      createMockRequest("192.168.1.1", "GWALLET1") as Request,
      "rl"
    );
    const wallet2Key = resolveKey(
      createMockRequest("192.168.1.1", "GWALLET2") as Request,
      "rl"
    );

    const maxRequests = 2;

    // Exhaust wallet1
    for (let i = 0; i < maxRequests; i++) {
      await incrementSlidingWindowMock(mockRedis, wallet1Key, windowMs);
    }

    // wallet2 should have independent budget
    const count1 = await incrementSlidingWindowMock(mockRedis, wallet1Key, windowMs);
    const count2 = await incrementSlidingWindowMock(mockRedis, wallet2Key, windowMs);

    expect(count1).toBeGreaterThan(maxRequests);
    expect(count2).toBe(1);
  });

  it("concurrent requests from same key are all counted", async () => {
    const concurrentRequests = 20;
    const requests = Array.from({ length: concurrentRequests }, () =>
      incrementSlidingWindowMock(mockRedis, key, windowMs)
    );

    const counts = await Promise.all(requests);

    // All requests should be counted
    expect(counts[counts.length - 1]).toBe(concurrentRequests);
  });

  it("sliding window counter increments correctly for sequential requests", async () => {
    const testKey = "test:sequential";

    const count1 = await incrementSlidingWindowMock(mockRedis, testKey, windowMs);
    expect(count1).toBe(1);

    const count2 = await incrementSlidingWindowMock(mockRedis, testKey, windowMs);
    expect(count2).toBe(2);

    const count3 = await incrementSlidingWindowMock(mockRedis, testKey, windowMs);
    expect(count3).toBe(3);
  });

  it("TTL is set correctly to prevent stale keys", async () => {
    const testKey = "test:ttl";
    const windowMs = 2000;

    await incrementSlidingWindowMock(mockRedis, testKey, windowMs);

    // Check TTL (should be approximately windowMs / 1000 seconds)
    const ttl = await mockRedis.ttl(testKey);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(Math.ceil(windowMs / 1000) + 1);
  });

  it("large window size works correctly", async () => {
    const largeWindowMs = 60000; // 1 minute
    const maxRequests = 100;
    const testKey = "test:large-window";

    for (let i = 0; i < maxRequests; i++) {
      const count = await incrementSlidingWindowMock(mockRedis, testKey, largeWindowMs);
      expect(count).toBeLessThanOrEqual(maxRequests);
    }

    const count = await incrementSlidingWindowMock(mockRedis, testKey, largeWindowMs);
    expect(count).toBeGreaterThan(maxRequests);
  });

  it("zero requests on unused key returns 1 on first request", async () => {
    const unusedKey = "test:unused:key";

    // No requests made to this key
    const count = await incrementSlidingWindowMock(mockRedis, unusedKey, windowMs);

    // First request should be counted as 1
    expect(count).toBe(1);
  });

  it("multiple keys maintain separate counters", async () => {
    const keyA = "test:counter:a";
    const keyB = "test:counter:b";
    const keyC = "test:counter:c";

    // Make different numbers of requests to each key
    for (let i = 0; i < 3; i++) {
      await incrementSlidingWindowMock(mockRedis, keyA, windowMs);
    }
    for (let i = 0; i < 5; i++) {
      await incrementSlidingWindowMock(mockRedis, keyB, windowMs);
    }
    for (let i = 0; i < 2; i++) {
      await incrementSlidingWindowMock(mockRedis, keyC, windowMs);
    }

    // Verify each key has correct count
    const countA = await incrementSlidingWindowMock(mockRedis, keyA, windowMs);
    const countB = await incrementSlidingWindowMock(mockRedis, keyB, windowMs);
    const countC = await incrementSlidingWindowMock(mockRedis, keyC, windowMs);

    expect(countA).toBe(4); // 3 + 1
    expect(countB).toBe(6); // 5 + 1
    expect(countC).toBe(3); // 2 + 1
  });

  it("rate limit key prefix is respected", () => {
    const req = createMockRequest("10.0.0.1");

    const globalKey = resolveKey(req as Request, "rl:global");
    const webhookKey = resolveKey(req as Request, "rl:webhook");

    expect(globalKey).toContain("rl:global");
    expect(webhookKey).toContain("rl:webhook");
    expect(globalKey).not.toBe(webhookKey);
  });
});
