/**
 * Prometheus metrics for the Pinata request queue (#1153).
 *
 * Registers gauges, counters, and a histogram against the project's shared
 * prom-client registry (imported from `../metrics/index.js`).
 *
 * Import this module once at application startup to activate collection.
 *
 * Exported helpers
 * ────────────────
 *  recordPinataMetrics(metrics)      — sync a queue snapshot into Prometheus
 *  observePinataRequestDuration(ms)  — record a single request duration sample
 */

import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "../metrics/index.js";
import { type PinataQueueMetrics } from "../ipfs/pinataQueue.js";

// ── Gauges ───────────────────────────────────────────────────────────────────

export const pinataQueueDepthGauge = new Gauge({
  name: "pinata_queue_depth",
  help: "Number of Pinata API requests currently waiting in the queue.",
  registers: [register],
});

export const pinataInFlightGauge = new Gauge({
  name: "pinata_in_flight",
  help: "Number of Pinata API requests currently in-flight.",
  registers: [register],
});

// ── Counters ─────────────────────────────────────────────────────────────────

export const pinataThrottledCounter = new Counter({
  name: "pinata_throttled_total",
  help: "Total number of times a Pinata request had to wait for a rate-limit token.",
  registers: [register],
});

export const pinata429RetriesCounter = new Counter({
  name: "pinata_429_retries_total",
  help: "Total number of 429 (rate-limit) retries performed against the Pinata API.",
  registers: [register],
});

// ── Histogram ─────────────────────────────────────────────────────────────────

export const pinataRequestDurationHistogram = new Histogram({
  name: "pinata_request_duration_ms",
  help: "End-to-end latency of Pinata API requests (ms), including queue wait time.",
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

// ── Sync helper ──────────────────────────────────────────────────────────────

let _lastThrottledCount = 0;
let _last429Count = 0;

/**
 * Synchronise a PinataQueueMetrics snapshot into Prometheus.
 *
 * Designed to be called on a periodic interval:
 *   setInterval(() => recordPinataMetrics(pinataQueue.getMetrics()), 10_000);
 */
export function recordPinataMetrics(metrics: PinataQueueMetrics): void {
  pinataQueueDepthGauge.set(metrics.queueDepth);
  pinataInFlightGauge.set(metrics.inFlight);

  // Counters must only increase — compute delta since last call.
  const throttledDelta = metrics.throttledCount - _lastThrottledCount;
  if (throttledDelta > 0) {
    pinataThrottledCounter.inc(throttledDelta);
    _lastThrottledCount = metrics.throttledCount;
  }

  const retriedDelta = metrics.retried429Count - _last429Count;
  if (retriedDelta > 0) {
    pinata429RetriesCounter.inc(retriedDelta);
    _last429Count = metrics.retried429Count;
  }
}

/**
 * Record a single request's end-to-end duration into the histogram.
 *
 * @param durationMs  Elapsed milliseconds (queue wait + execution).
 */
export function observePinataRequestDuration(durationMs: number): void {
  pinataRequestDurationHistogram.observe(durationMs);
}
