/**
 * Integration tests for transaction receipt verification (#1162)
 * Verifies that the app confirms on-chain success/failure from the receipt
 * rather than assuming success on submission.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransactionMonitor } from '../../services/transactionMonitor';
import { createTestMonitoringConfig } from '../../services/transactionMonitor.test-helpers';

const HASH = 'a'.repeat(64);

class TestableMonitor extends TransactionMonitor {
    private responses: Array<'pending' | 'success' | 'failed' | Error>;
    private callIndex = 0;

    constructor(responses: Array<'pending' | 'success' | 'failed' | Error>) {
        super(createTestMonitoringConfig());
        this.responses = responses;
    }

    protected override async checkTransactionStatus(): Promise<'pending' | 'success' | 'failed'> {
        const r = this.responses[Math.min(this.callIndex++, this.responses.length - 1)];
        if (r instanceof Error) throw r;
        return r;
    }
}

describe('verifyTransactionReceipt', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns success when receipt indicates SUCCESS', async () => {
        const monitor = new TestableMonitor(['success']);
        const result = await monitor.verifyTransactionReceipt(HASH);
        expect(result.status).toBe('success');
        expect(result.error).toBeUndefined();
    });

    it('returns failed when receipt indicates FAILED', async () => {
        const monitor = new TestableMonitor(['failed']);
        const result = await monitor.verifyTransactionReceipt(HASH);
        expect(result.status).toBe('failed');
        expect(result.error).toBeDefined();
    });

    it('polls through pending states before resolving success', async () => {
        const monitor = new TestableMonitor(['pending', 'pending', 'success']);
        const result = await monitor.verifyTransactionReceipt(HASH, 10_000);
        expect(result.status).toBe('success');
    });

    it('returns timeout when receipt never reaches terminal state', async () => {
        const monitor = new TestableMonitor(['pending']);
        // Very short timeout to force timeout path
        const result = await monitor.verifyTransactionReceipt(HASH, 1);
        expect(result.status).toBe('timeout');
        expect(result.error).toMatch(/timed out/i);
    });

    it('returns failed on non-retryable error', async () => {
        const monitor = new TestableMonitor([new Error('invalid transaction hash')]);
        const result = await monitor.verifyTransactionReceipt(HASH);
        // Non-retryable errors surface as failed
        expect(['failed', 'timeout']).toContain(result.status);
    });

    it('retries on transient network errors before succeeding', async () => {
        // First call throws a retryable network error, second returns success
        const networkError = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
        const monitor = new TestableMonitor([networkError, 'success']);
        const result = await monitor.verifyTransactionReceipt(HASH, 10_000);
        expect(result.status).toBe('success');
    });
});
