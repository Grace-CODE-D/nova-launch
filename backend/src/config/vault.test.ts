/**
 * Unit tests — VaultClient & loadSecrets
 * Issue: #896
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Reset singleton between tests
vi.mock('./vault', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./vault')>();
  return mod;
});

describe('VaultClient', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isEnabled returns false when role_id/secret_id are absent', async () => {
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    const { VaultClient } = await import('./vault');
    // Reset singleton
    (VaultClient as any).instance = undefined;
    const client = VaultClient.getInstance();
    expect(client.isEnabled).toBe(false);
  });

  it('isEnabled returns true when both credentials are set', async () => {
    process.env.VAULT_ROLE_ID    = 'test-role';
    process.env.VAULT_SECRET_ID  = 'test-secret';
    const { VaultClient } = await import('./vault');
    (VaultClient as any).instance = undefined;
    const client = VaultClient.getInstance();
    expect(client.isEnabled).toBe(true);
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
  });

  it('getSecrets fetches and caches secrets', async () => {
    process.env.VAULT_ROLE_ID    = 'role';
    process.env.VAULT_SECRET_ID  = 'secret';
    process.env.VAULT_ADDR       = 'http://vault:8200';

    const { VaultClient } = await import('./vault');
    (VaultClient as any).instance = undefined;
    const client = VaultClient.getInstance();

    const mockFetch = vi.fn()
      // First call: AppRole login
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: 'tok', lease_duration: 3600 } }),
      } as any)
      // Second call: KV read
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { data: { JWT_SECRET: 'super-secret' } } }),
      } as any);

    vi.stubGlobal('fetch', mockFetch);

    const secrets = await client.getSecrets('backend');
    expect(secrets.JWT_SECRET).toBe('super-secret');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call should use cache — no additional fetch
    const cached = await client.getSecrets('backend');
    expect(cached.JWT_SECRET).toBe('super-secret');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    delete process.env.VAULT_ADDR;
  });

  it('invalidate clears cache for a specific path', async () => {
    process.env.VAULT_ROLE_ID    = 'role';
    process.env.VAULT_SECRET_ID  = 'secret';

    const { VaultClient } = await import('./vault');
    (VaultClient as any).instance = undefined;
    const client = VaultClient.getInstance();

    const mockFetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ auth: { client_token: 'tok', lease_duration: 3600 } }),
      } as any);
    vi.stubGlobal('fetch', mockFetch);

    // Manually seed cache
    (client as any).cache.set('kv:backend', { value: '{"K":"V"}', expiresAt: Date.now() + 99999 });
    client.invalidate('backend');
    expect((client as any).cache.has('kv:backend')).toBe(false);

    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
  });
});

describe('loadSecrets', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
  });

  it('falls back to env vars when Vault is disabled', async () => {
    process.env.JWT_SECRET    = 'env-jwt';
    process.env.DATABASE_URL  = 'postgresql://localhost/test';

    const { loadSecrets, VaultClient } = await import('./vault');
    (VaultClient as any).instance = undefined;

    const secrets = await loadSecrets();
    expect(secrets.JWT_SECRET).toBe('env-jwt');
    expect(secrets.DATABASE_URL).toBe('postgresql://localhost/test');

    delete process.env.JWT_SECRET;
    delete process.env.DATABASE_URL;
  });
});
