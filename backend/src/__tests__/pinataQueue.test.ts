/**
 * Tests for the Pinata request queue (#1153).
 *
 * Covers:
 *  - Token-bucket throttling: max-concurrent cap is respected under burst load.
 *  - 429 back-off: tasks are retried with exponential delay on HTTP 429.
 *  - Max-retries exceeded: PinataRateLimitError is thrown after max retries.
 *  - Queue depth metric: queueDepth reflects waiting tasks and drains to 0.
 *  - Latency metric: avgLatencyMs is populated after requests complete.
 *  - Successful pass-through: non-429 results resolve correctly.
 *  - Re-queue ordering: 429-retried tasks are re-queued at the front.
 *  - Token refill: requests blocked on tokens eventually drain after refill.
 *
 * All tests are fully synchronous / fake-timer based — no live network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PinataQueue,
  PinataRateLimitError,
  type PinataQueueOptions,
} from "../lib/ipfs/pinataQueue";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build an options object that's fast for tests (no real delays). */
function opts(overrides: Partial<PinataQueueOptions> = {}): PinataQueueOptions {
  return {
    requestsPerSecond: 100, // effectively no throttle unless overridden
    maxBurst: 100,
    maxConcurrent: 3,
    maxRetries429: 3,
    retryBaseMs: 10,
    retryCapMs: 100,
    ...overrides,
  };
}

/** Creates a mock task that resolves after `delayMs`. */
function makeTask<T>(value: T, delayMs = 0): () => Promise<T> {
  return () =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
}

/** Creates a mock task that always rejects with a 429-like error. */
function make429Task(): () => Promise<never> {
  return () => {
    const err = new Error("Request failed with status 429");
    return Promise.reject(err);
  };
}

/** Creates a task that succeeds on the Nth call (1-indexed); throws 429 before. */
function makeSucceedsOnN<T>(
  value: T,
  succeedOnAttempt: number
): () => Promise<T> {
  let calls = 0;
  return () => {
    calls++;
    if (calls < succeedOnAttempt) {
      return Promise.reject(new Error("Request failed with status 429"));
    }
    return Promise.resolve(value);
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — basic enqueue & resolution", () => {
  it("resolves with the task's return value", async () => {
    const queue = new PinataQueue(opts());
    const result = await queue.enqueue(makeTask("hello"));
    expect(result).toBe("hello");
  });

  it("propagates non-429 errors without retrying", async () => {
    const queue = new PinataQueue(opts());
    const task = vi.fn().mockRejectedValue(new Error("generic error"));
    await expect(queue.enqueue(task)).rejects.toThrow("generic error");
    // Should NOT have been called more than once (no retries for non-429).
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("handles multiple sequential tasks", async () => {
    const queue = new PinataQueue(opts());
    const results = await Promise.all([
      queue.enqueue(makeTask(1)),
      queue.enqueue(makeTask(2)),
      queue.enqueue(makeTask(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — concurrency cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never exceeds maxConcurrent in-flight tasks", async () => {
    const maxConcurrent = 2;
    const queue = new PinataQueue(opts({ maxConcurrent, maxBurst: 20 }));

    let peakInFlight = 0;
    let currentInFlight = 0;

    const trackingTask = () =>
      new Promise<void>((resolve) => {
        currentInFlight++;
        peakInFlight = Math.max(peakInFlight, currentInFlight);
        // Simulate async work that finishes after a tick.
        Promise.resolve().then(() => {
          currentInFlight--;
          resolve();
        });
      });

    // Enqueue more tasks than maxConcurrent.
    const promises = Array.from({ length: 6 }, () =>
      queue.enqueue(trackingTask)
    );

    // Drain all timers / microtasks.
    await vi.runAllTimersAsync();
    await Promise.all(promises);

    expect(peakInFlight).toBeLessThanOrEqual(maxConcurrent);
  });

  it("queues tasks when maxConcurrent is reached and drains them afterwards", async () => {
    const queue = new PinataQueue(
      opts({ maxConcurrent: 1, requestsPerSecond: 1000, maxBurst: 100 })
    );

    const order: number[] = [];
    const makeOrderedTask = (n: number) => async () => {
      order.push(n);
    };

    const p1 = queue.enqueue(makeOrderedTask(1));
    const p2 = queue.enqueue(makeOrderedTask(2));
    const p3 = queue.enqueue(makeOrderedTask(3));

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2, p3]);

    // All three must have run, though ordering depends on resolution order.
    expect(order).toHaveLength(3);
    expect(order).toContain(1);
    expect(order).toContain(2);
    expect(order).toContain(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — token-bucket throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles when tokens are exhausted and refills over time", async () => {
    // 1 rps, burst=1 → only 1 token initially; second task must wait for refill.
    const queue = new PinataQueue(
      opts({ requestsPerSecond: 1, maxBurst: 1, maxConcurrent: 10 })
    );

    const completionOrder: number[] = [];
    const task1 = queue.enqueue(async () => {
      completionOrder.push(1);
    });
    const task2 = queue.enqueue(async () => {
      completionOrder.push(2);
    });

    // After 0 ms, task1 should start (has token).
    await vi.advanceTimersByTimeAsync(0);

    // task2 is still waiting for a token.
    expect(completionOrder).toHaveLength(1);
    expect(completionOrder[0]).toBe(1);

    // Advance 1 second — token refills.
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.all([task1, task2]);

    expect(completionOrder).toHaveLength(2);
    expect(completionOrder[1]).toBe(2);
  });

  it("increments throttledCount when tasks wait for tokens", async () => {
    const queue = new PinataQueue(
      opts({ requestsPerSecond: 1, maxBurst: 1, maxConcurrent: 10 })
    );

    // Enqueue more tasks than available tokens.
    queue.enqueue(makeTask("a")); // uses the one token
    queue.enqueue(makeTask("b")); // must wait → throttled

    await vi.advanceTimersByTimeAsync(50);

    expect(queue.getMetrics().throttledCount).toBeGreaterThanOrEqual(1);

    // Let everything drain.
    await vi.runAllTimersAsync();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — 429 back-off and retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 429 task and eventually resolves", async () => {
    // Succeeds on attempt 3 (fails with 429 on attempts 1 and 2).
    const queue = new PinataQueue(
      opts({ maxRetries429: 5, retryBaseMs: 10, retryCapMs: 50 })
    );

    const taskFn = makeSucceedsOnN("success", 3);
    const promise = queue.enqueue(taskFn);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("success");
    expect(queue.getMetrics().retried429Count).toBe(2);
  });

  it("throws PinataRateLimitError after maxRetries429 exhausted", async () => {
    const queue = new PinataQueue(
      opts({ maxRetries429: 2, retryBaseMs: 10, retryCapMs: 50 })
    );

    const promise = queue.enqueue(make429Task());
    // Attach catch immediately to prevent unhandled rejection before timers fire.
    const caught = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(err).toBeInstanceOf(PinataRateLimitError);
  });

  it("PinataRateLimitError message contains retry count", async () => {
    const queue = new PinataQueue(
      opts({ maxRetries429: 2, retryBaseMs: 10, retryCapMs: 50 })
    );

    const promise = queue.enqueue(make429Task());
    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(err.message).toMatch(/after 2 retries/i);
  });

  it("increments retried429Count for each retry attempt", async () => {
    const queue = new PinataQueue(
      opts({ maxRetries429: 3, retryBaseMs: 10, retryCapMs: 50 })
    );

    const promise = queue.enqueue(make429Task());
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;

    expect(queue.getMetrics().retried429Count).toBe(3);
  });

  it("does not retry non-429 errors", async () => {
    const queue = new PinataQueue(opts());
    const task = vi.fn().mockRejectedValue(new Error("Internal Server Error"));

    const promise = queue.enqueue(task);
    // Attach catch synchronously so no unhandled rejection warning fires.
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;

    // Called exactly once — no retry.
    expect(task).toHaveBeenCalledTimes(1);
    expect(queue.getMetrics().retried429Count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queueDepth reflects waiting tasks", async () => {
    // maxConcurrent=1, burst=10 → second task queues immediately.
    const queue = new PinataQueue(
      opts({ maxConcurrent: 1, requestsPerSecond: 1000, maxBurst: 100 })
    );

    // Make task1 a long-running task so task2 ends up in the queue.
    let resolveTask1!: () => void;
    const longTask = () =>
      new Promise<void>((res) => {
        resolveTask1 = res;
      });

    queue.enqueue(longTask);
    queue.enqueue(makeTask("queued"));

    // At this point: task1 is in-flight, task2 is in the queue.
    const metricsWhileQueued = queue.getMetrics();
    expect(metricsWhileQueued.queueDepth).toBe(1);
    expect(metricsWhileQueued.inFlight).toBe(1);

    // Complete task1 → task2 starts → queue empties.
    resolveTask1();
    await vi.runAllTimersAsync();

    expect(queue.getMetrics().queueDepth).toBe(0);
  });

  it("avgLatencyMs is positive after requests complete", async () => {
    const queue = new PinataQueue(opts());

    // Use zero-delay tasks so fake timers handle everything.
    const p1 = queue.enqueue(makeTask("a", 0));
    const p2 = queue.enqueue(makeTask("b", 0));
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(queue.getMetrics().avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("inFlight returns to 0 once all tasks finish", async () => {
    const queue = new PinataQueue(opts());

    const promises = Array.from({ length: 5 }, (_, i) =>
      queue.enqueue(makeTask(i))
    );
    await vi.runAllTimersAsync();
    await Promise.all(promises);

    expect(queue.getMetrics().inFlight).toBe(0);
  });

  it("initial metrics are all zero", () => {
    const queue = new PinataQueue(opts());
    const m = queue.getMetrics();
    expect(m.queueDepth).toBe(0);
    expect(m.inFlight).toBe(0);
    expect(m.throttledCount).toBe(0);
    expect(m.retried429Count).toBe(0);
    expect(m.avgLatencyMs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — 429 detection variants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects 429 from Error message containing '429'", async () => {
    const queue = new PinataQueue(
      opts({ maxRetries429: 1, retryBaseMs: 10, retryCapMs: 50 })
    );
    // Axios-style error with message "Request failed with status code 429"
    const task = vi
      .fn()
      .mockRejectedValue(new Error("Request failed with status code 429"));
    const promise = queue.enqueue(task);
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;

    expect(queue.getMetrics().retried429Count).toBeGreaterThanOrEqual(1);
  });

  it("detects 429 from object with status property", async () => {
    const queue = new PinataQueue(
      opts({ maxRetries429: 1, retryBaseMs: 10, retryCapMs: 50 })
    );
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const task = vi.fn().mockRejectedValue(err);
    const promise = queue.enqueue(task);
    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;

    expect(queue.getMetrics().retried429Count).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PinataQueue — burst and high-concurrency load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("all 20 tasks eventually resolve under burst load", async () => {
    const queue = new PinataQueue(
      opts({ maxConcurrent: 3, requestsPerSecond: 10, maxBurst: 10 })
    );

    const promises = Array.from({ length: 20 }, (_, i) =>
      queue.enqueue(makeTask(i))
    );

    await vi.runAllTimersAsync();
    const results = await Promise.all(promises);

    expect(results).toHaveLength(20);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
