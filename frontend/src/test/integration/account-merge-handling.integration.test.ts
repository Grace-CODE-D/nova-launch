/**
 * Integration tests for Stellar account-merge and missing-account handling (#1166).
 * Verifies that flows querying accounts return a clear typed state instead of throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StellarService } from '../../services/stellar.service';

vi.mock('../../config/stellar', () => ({
    STELLAR_CONFIG: {
        network: 'testnet',
        factoryContractId: '',
        networkPassphrase: 'Test SDF Network ; September 2015',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    },
    getNetworkConfig: () => ({
        networkPassphrase: 'Test SDF Network ; September 2015',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    }),
    ACTIVE_NETWORK: 'testnet',
}));

const EXISTING_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MISSING_ADDRESS  = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

describe('StellarService.getAccountSafe', () => {
    let service: StellarService;

    beforeEach(() => {
        service = new StellarService('testnet');
    });

    it('returns found:true for an existing account', async () => {
        const mockAccount = { id: EXISTING_ADDRESS, sequence: '1234' };
        vi.spyOn(service['server'], 'getAccount').mockResolvedValue(mockAccount as any);

        const result = await service.getAccountSafe(EXISTING_ADDRESS);

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.account).toBe(mockAccount);
        }
    });

    it('returns found:false with reason "missing" for a 404 / not-found error', async () => {
        vi.spyOn(service['server'], 'getAccount').mockRejectedValue(
            new Error('Request failed with status code 404: account not found')
        );

        const result = await service.getAccountSafe(MISSING_ADDRESS);

        expect(result.found).toBe(false);
        if (!result.found) {
            expect(result.reason).toBe('missing');
        }
    });

    it('returns found:false with reason "missing" for a merged account (does not exist)', async () => {
        vi.spyOn(service['server'], 'getAccount').mockRejectedValue(
            new Error('Account does not exist')
        );

        const result = await service.getAccountSafe(MISSING_ADDRESS);

        expect(result.found).toBe(false);
        if (!result.found) {
            expect(result.reason).toBe('missing');
        }
    });

    it('returns found:false with reason "error" for unexpected errors', async () => {
        vi.spyOn(service['server'], 'getAccount').mockRejectedValue(
            new Error('Network timeout')
        );

        const result = await service.getAccountSafe(EXISTING_ADDRESS);

        expect(result.found).toBe(false);
        if (!result.found) {
            expect(result.reason).toBe('error');
            expect(result.error).toMatch(/network timeout/i);
        }
    });

    it('does not throw — always returns a typed result', async () => {
        vi.spyOn(service['server'], 'getAccount').mockRejectedValue(
            new Error('some unexpected error')
        );

        await expect(service.getAccountSafe(MISSING_ADDRESS)).resolves.toBeDefined();
    });
});
