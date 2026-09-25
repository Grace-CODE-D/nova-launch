import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Setup Mocks before import ──────────────────────────────────────────────

const mockPinFileToIPFS = vi.fn();
const mockPinJSONToIPFS = vi.fn();
const mockPinByHash = vi.fn();

vi.mock("@pinata/sdk", () => {
  return {
    default: class MockPinataSDK {
      pinFileToIPFS = mockPinFileToIPFS;
      pinJSONToIPFS = mockPinJSONToIPFS;
      pinByHash = mockPinByHash;
    },
  };
});

const mockNodeCacheGet = vi.fn();
const mockNodeCacheSet = vi.fn();

vi.mock("node-cache", () => {
  return {
    default: class MockNodeCache {
      get = mockNodeCacheGet;
      set = mockNodeCacheSet;
    },
  };
});

vi.mock("../cidVerification.js", () => ({
  CIDMismatchError: class CIDMismatchError extends Error {},
  verifyCIDContent: vi.fn().mockResolvedValue(true),
  verifyMetadataCID: vi.fn().mockResolvedValue(true),
}));

vi.mock("./cidVerification.js", () => ({
  CIDMismatchError: class CIDMismatchError extends Error {},
  verifyCIDContent: vi.fn().mockResolvedValue(true),
  verifyMetadataCID: vi.fn().mockResolvedValue(true),
}));

vi.mock("../circuitBreaker.js", () => ({
  CircuitBreaker: class MockCircuitBreaker {
    execute = vi.fn(async (fn: () => any) => fn());
    getMetrics = vi.fn().mockReturnValue({ state: "CLOSED", failures: 0 });
    reset = vi.fn();
  },
  registerCircuitBreaker: vi.fn(),
}));

vi.mock("../metrics/index.js", () => ({
  register: {},
}));

vi.mock("prom-client", () => ({
  Counter: class MockCounter {
    inc = vi.fn();
  },
}));

vi.mock("./pinataQueue.js", () => ({
  pinataQueue: {
    enqueue: vi.fn(async (fn: () => any) => fn()),
    getMetrics: vi.fn().mockReturnValue({
      queueDepth: 0,
      inFlight: 0,
      throttledCount: 0,
      retried429Count: 0,
      avgLatencyMs: 10,
    }),
  },
}));

vi.mock("./gatewayRouter.js", () => ({
  gatewayRouter: {
    fetch: vi.fn(),
  },
}));

// Import subject under test
import {
  validatePinataCredentials,
  rotatePinataCredentials,
  getActivePinataCredentials,
  rePinFromGateway,
  uploadImageToIPFS,
  uploadMetadataToIPFS,
  getMetadataFromIPFS,
  getIPFSCircuitBreakerMetrics,
  resetIPFSCircuitBreaker,
  getPinataQueueMetrics,
} from "../pinata";
import { gatewayRouter } from "./gatewayRouter.js";

describe("Pinata IPFS Upload Client (backend/src/lib/ipfs/pinata.ts)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PINATA_API_KEY = "test-api-key";
    process.env.PINATA_API_SECRET = "test-api-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("validatePinataCredentials", () => {
    it("returns true when pinList check returns ok", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
      } as any);

      const isValid = await validatePinataCredentials("validKey", "validSecret");
      expect(isValid).toBe(true);

      globalThis.fetch = originalFetch;
    });

    it("returns false when fetch response is not ok", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
      } as any);

      const isValid = await validatePinataCredentials("badKey", "badSecret");
      expect(isValid).toBe(false);

      globalThis.fetch = originalFetch;
    });

    it("returns false when fetch throws a network error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Network timeout"));

      const isValid = await validatePinataCredentials("key", "secret");
      expect(isValid).toBe(false);

      globalThis.fetch = originalFetch;
    });
  });

  describe("rotatePinataCredentials", () => {
    it("successfully rotates credentials when validation succeeds", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true } as any);

      await rotatePinataCredentials("newKey", "newSecret");
      const active = getActivePinataCredentials();
      expect(active).toEqual({ apiKey: "newKey", apiSecret: "newSecret" });

      globalThis.fetch = originalFetch;
    });

    it("throws error when validation fails during rotation", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false } as any);

      await expect(
        rotatePinataCredentials("invalidKey", "invalidSecret")
      ).rejects.toThrow("Pinata credential validation failed");

      globalThis.fetch = originalFetch;
    });
  });

  describe("getActivePinataCredentials", () => {
    it("returns a copy of active credentials", () => {
      const creds = getActivePinataCredentials();
      expect(creds.apiKey).toBeDefined();
      expect(creds.apiSecret).toBeDefined();
    });
  });

  describe("rePinFromGateway", () => {
    it("successfully triggers pinByHash on pinata client", async () => {
      mockPinByHash.mockResolvedValueOnce({ id: "pin123" });
      await expect(rePinFromGateway("QmTestCID123")).resolves.toBeUndefined();
      expect(mockPinByHash).toHaveBeenCalledWith("QmTestCID123", {
        pinataMetadata: { name: "repin-QmTestCID123" },
      });
    });

    it("propagates error if pinByHash fails", async () => {
      mockPinByHash.mockRejectedValueOnce(new Error("Pin failed"));
      await expect(rePinFromGateway("QmTestCID123")).rejects.toThrow("Pin failed");
    });
  });

  describe("uploadImageToIPFS", () => {
    it("uploads buffer to pinata and returns IpfsHash", async () => {
      mockPinFileToIPFS.mockResolvedValueOnce({ IpfsHash: "QmImageHash123" });

      const buffer = Buffer.from("image data");
      const cid = await uploadImageToIPFS(buffer, "test.png");
      expect(cid).toBe("QmImageHash123");
      expect(mockPinFileToIPFS).toHaveBeenCalledWith(buffer, {
        pinataMetadata: { name: "test.png" },
      });
    });

    it("throws error when upload fails", async () => {
      mockPinFileToIPFS.mockRejectedValueOnce(new Error("Upload rate limit exceeded"));

      const buffer = Buffer.from("image data");
      await expect(uploadImageToIPFS(buffer, "test.png")).rejects.toThrow(
        "Upload rate limit exceeded"
      );
    });
  });

  describe("uploadMetadataToIPFS", () => {
    it("uploads JSON to pinata, caches it, and returns IpfsHash", async () => {
      mockPinJSONToIPFS.mockResolvedValueOnce({ IpfsHash: "QmMetaHash123" });

      const metadata = { name: "Token", description: "NFT" };
      const cid = await uploadMetadataToIPFS(metadata);

      expect(cid).toBe("QmMetaHash123");
      expect(mockPinJSONToIPFS).toHaveBeenCalledWith(metadata);
      expect(mockNodeCacheSet).toHaveBeenCalledWith("QmMetaHash123", metadata);
    });

    it("throws error when pinJSONToIPFS fails", async () => {
      mockPinJSONToIPFS.mockRejectedValueOnce(new Error("JSON upload failure"));

      await expect(
        uploadMetadataToIPFS({ name: "Fail" })
      ).rejects.toThrow("JSON upload failure");
    });
  });

  describe("getMetadataFromIPFS", () => {
    it("returns cached metadata if present without calling gateway router", async () => {
      const cachedData = { name: "CachedToken" };
      mockNodeCacheGet.mockReturnValueOnce(cachedData);

      const result = await getMetadataFromIPFS("QmExistingCID");
      expect(result).toEqual(cachedData);
      expect(gatewayRouter.fetch).not.toHaveBeenCalled();
    });

    it("fetches metadata via gatewayRouter and caches result if not in cache", async () => {
      mockNodeCacheGet.mockReturnValueOnce(undefined);
      const fetchedData = { name: "RemoteToken" };
      (gatewayRouter.fetch as any).mockResolvedValueOnce(fetchedData);

      const result = await getMetadataFromIPFS("QmRemoteCID");
      expect(result).toEqual(fetchedData);
      expect(gatewayRouter.fetch).toHaveBeenCalledWith("QmRemoteCID");
      expect(mockNodeCacheSet).toHaveBeenCalledWith("QmRemoteCID", fetchedData);
    });

    it("propagates error when gatewayRouter fetch fails", async () => {
      mockNodeCacheGet.mockReturnValueOnce(undefined);
      (gatewayRouter.fetch as any).mockRejectedValueOnce(
        new Error("All gateways timed out")
      );

      await expect(getMetadataFromIPFS("QmFailedCID")).rejects.toThrow(
        "All gateways timed out"
      );
    });
  });

  describe("Observability helpers", () => {
    it("returns circuit breaker metrics", () => {
      const metrics = getIPFSCircuitBreakerMetrics();
      expect(metrics).toEqual({ state: "CLOSED", failures: 0 });
    });

    it("resets IPFS circuit breaker without throwing", () => {
      expect(() => resetIPFSCircuitBreaker()).not.toThrow();
    });

    it("returns Pinata queue metrics", () => {
      const metrics = getPinataQueueMetrics();
      expect(metrics).toEqual({
        queueDepth: 0,
        inFlight: 0,
        throttledCount: 0,
        retried429Count: 0,
        avgLatencyMs: 10,
      });
    });
  });
});
