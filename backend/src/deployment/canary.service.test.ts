/**
 * Unit tests — CanaryDeploymentService
 * Issue: #895
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CanaryDeploymentService, type CanaryMetrics } from './canary.service';

vi.mock('../../monitoring/logging/structured-logger', () => ({
  structuredLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const healthyMetrics = (): CanaryMetrics => ({
  errorRate:        0.5,
  p99LatencyMs:     200,
  healthCheckPassed: true,
  timestamp:        new Date(),
});

describe('CanaryDeploymentService', () => {
  let svc: CanaryDeploymentService;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = new CanaryDeploymentService({
      weight:               10,
      bakeTimeMs:           60_000,
      errorRateThreshold:   5,
      latencyThresholdMs:   2_000,
      autoRollback:         true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── start ──────────────────────────────────────────────────────────────────

  it('transitions to observing after start', async () => {
    await svc.start('v2', 'v1');
    expect(svc.getState().stage).toBe('observing');
  });

  it('throws when starting while already observing', async () => {
    await svc.start('v2', 'v1');
    await expect(svc.start('v3', 'v2')).rejects.toThrow("current stage is 'observing'");
  });

  it('records canary and stable versions', async () => {
    await svc.start('canary-abc', 'stable-xyz');
    const state = svc.getState();
    expect(state.canaryVersion).toBe('canary-abc');
    expect(state.stableVersion).toBe('stable-xyz');
  });

  // ── evaluateMetrics ────────────────────────────────────────────────────────

  it('stays in observing with healthy metrics', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics(healthyMetrics());
    expect(svc.getState().stage).toBe('observing');
  });

  it('rolls back when error rate exceeds threshold', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics({ ...healthyMetrics(), errorRate: 10 });
    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toContain('error rate');
  });

  it('rolls back when p99 latency exceeds threshold', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics({ ...healthyMetrics(), p99LatencyMs: 3_000 });
    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toContain('p99 latency');
  });

  it('rolls back when health check fails', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics({ ...healthyMetrics(), healthCheckPassed: false });
    expect(svc.getState().stage).toBe('rolled_back');
    expect(svc.getState().rollbackReason).toBe('health check failed');
  });

  it('does not auto-rollback when autoRollback is false', async () => {
    const manual = new CanaryDeploymentService({ autoRollback: false });
    await manual.start('v2', 'v1');
    await manual.evaluateMetrics({ ...healthyMetrics(), errorRate: 99 });
    expect(manual.getState().stage).toBe('observing');
  });

  // ── manual rollback ────────────────────────────────────────────────────────

  it('supports manual rollback', async () => {
    await svc.start('v2', 'v1');
    await svc.rollback('manual override');
    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toBe('manual override');
  });

  // ── promotion ─────────────────────────────────────────────────────────────

  it('promotes to complete after bake time with healthy metrics', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics(healthyMetrics());
    // Advance past bake time
    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();
    expect(svc.getState().stage).toBe('complete');
  });

  // ── restart after terminal state ───────────────────────────────────────────

  it('can restart after rollback', async () => {
    await svc.start('v2', 'v1');
    await svc.rollback('test');
    await svc.start('v3', 'v2');
    expect(svc.getState().stage).toBe('observing');
  });

  it('can restart after complete', async () => {
    await svc.start('v2', 'v1');
    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();
    await svc.start('v3', 'v2');
    expect(svc.getState().stage).toBe('observing');
  });
});
