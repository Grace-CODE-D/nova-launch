import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Setup Mocks ─────────────────────────────────────────────────────────────

const mockRunNetworkValidation = vi.fn();
const mockValidateEnv = vi.fn();

vi.mock('../../../config/startupValidation', () => ({
  runNetworkValidation: (...args: any[]) => mockRunNetworkValidation(...args),
}));

vi.mock('../../../config/env', () => ({
  validateEnv: (...args: any[]) => mockValidateEnv(...args),
}));

let mockAdminUser: any = { id: 'admin-1', role: 'admin' };

vi.mock('../../../middleware/auth', () => ({
  authenticateAdmin: (req: any, res: any, next: any) => {
    if (!mockAdminUser) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    req.admin = mockAdminUser;
    next();
  },
}));

import networkRouter from '../network';

describe('Admin Network-Validation Route (backend/src/routes/admin/network.ts)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminUser = { id: 'admin-1', role: 'admin' };

    app = express();
    app.use(express.json());
    app.use('/api/admin/network', networkRouter);
  });

  describe('GET /api/admin/network', () => {
    it('returns reachability report on successful validation', async () => {
      const mockEnv = { STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org' };
      const mockReport = {
        horizon: { reachable: true, latencyMs: 45, passphraseMatches: true },
        rpc: { reachable: true },
        ipfs: { reachable: true },
      };

      mockValidateEnv.mockReturnValueOnce(mockEnv);
      mockRunNetworkValidation.mockResolvedValueOnce(mockReport);

      const res = await request(app).get('/api/admin/network');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockReport);
      expect(mockValidateEnv).toHaveBeenCalled();
      expect(mockRunNetworkValidation).toHaveBeenCalledWith(mockEnv);
    });

    it('returns 500 when network validation fails or throws error', async () => {
      mockValidateEnv.mockReturnValueOnce({});
      mockRunNetworkValidation.mockRejectedValueOnce(new Error('Validation failed catastrophically'));

      const res = await request(app).get('/api/admin/network');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toEqual({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Network validation failed',
      });
    });

    it('returns 401 when request is not authenticated', async () => {
      mockAdminUser = null;

      const res = await request(app).get('/api/admin/network');
      expect(res.status).toBe(401);
    });
  });
});
