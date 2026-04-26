/**
 * Canary Deployment Service — Nova Launch
 * Issue: #895
 *
 * Tracks canary state, evaluates health metrics, and triggers rollback
 * when error rate or latency thresholds are breached.
 */

import { structuredLogger } from '../../monitoring/logging/structured-logger';

export type CanaryStage = 'idle' | 'deploying' | 'observing' | 'promoting' | 'rolled_back' | 'complete';

export interface CanaryConfig {
  /** Traffic weight sent to canary (0–100). */
  weight: number;
  /** Observation window in milliseconds. */
  bakeTimeMs: number;
  /** Max acceptable error rate percentage. */
  errorRateThreshold: number;
  /** Max acceptable p99 latency in ms. */
  latencyThresholdMs: number;
  /** Whether to roll back automatically on threshold breach. */
  autoRollback: boolean;
}

export interface CanaryMetrics {
  errorRate: number;
  p99LatencyMs: number;
  healthCheckPassed: boolean;
  timestamp: Date;
}

export interface CanaryState {
  stage: CanaryStage;
  canaryVersion: string;
  stableVersion: string;
  startedAt: Date | null;
  lastMetrics: CanaryMetrics | null;
  rollbackReason: string | null;
}

const DEFAULT_CONFIG: CanaryConfig = {
  weight:               10,
  bakeTimeMs:           300_000, // 5 min
  errorRateThreshold:   5,
  latencyThresholdMs:   2_000,
  autoRollback:         true,
};

export class CanaryDeploymentService {
  private state: CanaryState = {
    stage:          'idle',
    canaryVersion:  '',
    stableVersion:  '',
    startedAt:      null,
    lastMetrics:    null,
    rollbackReason: null,
  };

  private observationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: CanaryConfig;

  constructor(config: Partial<CanaryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Begin a canary deployment. */
  async start(canaryVersion: string, stableVersion: string): Promise<void> {
    if (this.state.stage !== 'idle' && this.state.stage !== 'complete' && this.state.stage !== 'rolled_back') {
      throw new Error(`Cannot start canary: current stage is '${this.state.stage}'`);
    }

    this.state = {
      stage:          'deploying',
      canaryVersion,
      stableVersion,
      startedAt:      new Date(),
      lastMetrics:    null,
      rollbackReason: null,
    };

    structuredLogger.info('Canary deployment started', {
      canaryVersion,
      stableVersion,
      weight: this.config.weight,
    });

    this.transitionTo('observing');
    this.startObservation();
  }

  /** Manually trigger rollback. */
  async rollback(reason: string): Promise<void> {
    await this.performRollback(reason);
  }

  /** Get current canary state (for health endpoint / API). */
  getState(): Readonly<CanaryState> {
    return { ...this.state };
  }

  /** Feed fresh metrics into the canary evaluator. */
  async evaluateMetrics(metrics: CanaryMetrics): Promise<void> {
    this.state.lastMetrics = metrics;

    if (this.state.stage !== 'observing') return;

    const breached = this.checkThresholds(metrics);
    if (breached) {
      if (this.config.autoRollback) {
        await this.performRollback(breached);
      } else {
        structuredLogger.warn('Canary threshold breached — auto-rollback disabled', { reason: breached });
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private transitionTo(stage: CanaryStage): void {
    structuredLogger.info('Canary stage transition', {
      from: this.state.stage,
      to:   stage,
    });
    this.state.stage = stage;
  }

  private startObservation(): void {
    const checkIntervalMs = 30_000;
    const endTime = Date.now() + this.config.bakeTimeMs;

    this.observationTimer = setInterval(async () => {
      if (Date.now() >= endTime) {
        this.stopObservation();
        await this.promote();
        return;
      }

      // Metrics are fed externally via evaluateMetrics(); log current state
      if (this.state.lastMetrics) {
        structuredLogger.info('Canary observation tick', {
          stage:       this.state.stage,
          errorRate:   this.state.lastMetrics.errorRate,
          p99Latency:  this.state.lastMetrics.p99LatencyMs,
          remaining:   Math.max(0, endTime - Date.now()),
        });
      }
    }, checkIntervalMs);
  }

  private stopObservation(): void {
    if (this.observationTimer) {
      clearInterval(this.observationTimer);
      this.observationTimer = null;
    }
  }

  private checkThresholds(metrics: CanaryMetrics): string | null {
    if (!metrics.healthCheckPassed) return 'health check failed';
    if (metrics.errorRate > this.config.errorRateThreshold) {
      return `error rate ${metrics.errorRate.toFixed(2)}% exceeds threshold ${this.config.errorRateThreshold}%`;
    }
    if (metrics.p99LatencyMs > this.config.latencyThresholdMs) {
      return `p99 latency ${metrics.p99LatencyMs}ms exceeds threshold ${this.config.latencyThresholdMs}ms`;
    }
    return null;
  }

  private async promote(): Promise<void> {
    this.transitionTo('promoting');
    structuredLogger.info('Promoting canary to stable', {
      canaryVersion: this.state.canaryVersion,
    });
    // Concrete promotion logic (kubectl / load-balancer update) lives in canary-deploy.sh
    this.transitionTo('complete');
    structuredLogger.info('Canary promotion complete', {
      version: this.state.canaryVersion,
    });
  }

  private async performRollback(reason: string): Promise<void> {
    this.stopObservation();
    this.state.rollbackReason = reason;
    this.transitionTo('rolled_back');
    structuredLogger.error('Canary rollback triggered', {
      reason,
      canaryVersion:  this.state.canaryVersion,
      stableVersion:  this.state.stableVersion,
    });
    // Concrete rollback (kubectl scale / nginx upstream) lives in canary-deploy.sh
  }
}

// Singleton for use across the application
export const canaryService = new CanaryDeploymentService();
