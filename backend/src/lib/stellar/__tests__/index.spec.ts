import { describe, it, expect, vi, beforeEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  stellarConfig,
  getHorizonServer,
  getSorobanServer,
  fetchAccountInfo,
  submitTransaction,
  getNetworkPassphrase,
  createTransactionBuilder,
  getCurrentBaseFee,
  addressExists,
  getAccountBalances,
} from "../index";

vi.mock("@stellar/stellar-sdk", () => {
  const mockCall = vi.fn();
  const mockAccountId = vi.fn().mockReturnValue({ call: mockCall });
  const mockAccounts = vi.fn().mockReturnValue({ accountId: mockAccountId });
  const mockFeeStats = vi.fn();
  const mockSubmitTransaction = vi.fn();

  class MockHorizonServer {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    accounts = mockAccounts;
    feeStats = mockFeeStats;
    submitTransaction = mockSubmitTransaction;
  }

  class MockRpcServer {
    url: string;
    options: any;
    constructor(url: string, options?: any) {
      this.url = url;
      this.options = options;
    }
  }

  class MockTransactionBuilder {
    sourceAccount: any;
    options: any;
    constructor(sourceAccount: any, options?: any) {
      this.sourceAccount = sourceAccount;
      this.options = options;
    }
    static fromXDR = vi.fn().mockReturnValue({ id: "mock-tx" });
  }

  return {
    Horizon: {
      Server: MockHorizonServer,
    },
    rpc: {
      Server: MockRpcServer,
    },
    Networks: {
      PUBLIC: "Public Global Stellar Network ; September 2015",
      TESTNET: "Test SDF Network ; September 2015",
    },
    BASE_FEE: "100",
    TransactionBuilder: MockTransactionBuilder,
  };
});

describe("Stellar SDK Client Factory & Utils (backend/src/lib/stellar/index.ts)", () => {
  const validPublicKey = "G" + "A".repeat(55);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getHorizonServer", () => {
    it("creates Horizon server instance with default configuration", () => {
      const server = getHorizonServer();
      expect(server).toBeDefined();
      expect((server as any).url).toBe(stellarConfig.horizonUrl);
    });

    it("creates Horizon server instance with custom configuration", () => {
      const customConfig = {
        network: "mainnet" as const,
        horizonUrl: "https://custom-horizon.stellar.org",
        sorobanRpcUrl: "https://custom-soroban.stellar.org",
        factoryContractId: "CFAC123",
      };
      const server = getHorizonServer(customConfig);
      expect(server).toBeDefined();
      expect((server as any).url).toBe("https://custom-horizon.stellar.org");
    });
  });

  describe("getSorobanServer", () => {
    it("creates Soroban RPC server instance with default configuration", () => {
      const server = getSorobanServer();
      expect(server).toBeDefined();
      expect((server as any).url).toBe(stellarConfig.sorobanRpcUrl);
      expect((server as any).options.timeout).toBe(30000);
    });

    it("creates Soroban RPC server instance with custom configuration", () => {
      const customConfig = {
        network: "testnet" as const,
        horizonUrl: "https://custom-horizon.stellar.org",
        sorobanRpcUrl: "https://custom-soroban.stellar.org",
        factoryContractId: "",
      };
      const server = getSorobanServer(customConfig);
      expect(server).toBeDefined();
      expect((server as any).url).toBe("https://custom-soroban.stellar.org");
    });
  });

  describe("getNetworkPassphrase", () => {
    it("returns public network passphrase for mainnet", () => {
      const passphrase = getNetworkPassphrase({
        network: "mainnet",
        horizonUrl: "",
        sorobanRpcUrl: "",
        factoryContractId: "",
      });
      expect(passphrase).toBe(StellarSdk.Networks.PUBLIC);
    });

    it("returns testnet passphrase for testnet", () => {
      const passphrase = getNetworkPassphrase({
        network: "testnet",
        horizonUrl: "",
        sorobanRpcUrl: "",
        factoryContractId: "",
      });
      expect(passphrase).toBe(StellarSdk.Networks.TESTNET);
    });

    it("throws error for unknown network", () => {
      expect(() =>
        getNetworkPassphrase({
          network: "futurenet" as any,
          horizonUrl: "",
          sorobanRpcUrl: "",
          factoryContractId: "",
        })
      ).toThrow("Unknown network: futurenet");
    });
  });

  describe("fetchAccountInfo", () => {
    it("successfully fetches account info for valid public key", async () => {
      const mockRecord = { id: validPublicKey, sequence: "123" };
      const server = getHorizonServer();
      (server.accounts().accountId(validPublicKey).call as any).mockResolvedValueOnce(mockRecord);

      const result = await fetchAccountInfo(validPublicKey);
      expect(result).toEqual(mockRecord);
      expect(server.accounts().accountId).toHaveBeenCalledWith(validPublicKey);
    });

    it("throws an error when public key format is invalid", async () => {
      await expect(fetchAccountInfo("invalidKey")).rejects.toThrow(
        "Invalid Stellar public key: invalidKey"
      );
    });
  });

  describe("submitTransaction", () => {
    it("submits signed transaction XDR successfully", async () => {
      const server = getHorizonServer();
      const mockResponse = { successful: true, hash: "txhash123" };
      (server.submitTransaction as any).mockResolvedValueOnce(mockResponse);

      const result = await submitTransaction("AAA_MOCK_XDR");
      expect(StellarSdk.TransactionBuilder.fromXDR).toHaveBeenCalledWith(
        "AAA_MOCK_XDR",
        StellarSdk.Networks.TESTNET
      );
      expect(server.submitTransaction).toHaveBeenCalled();
      expect(result).toEqual(mockResponse);
    });

    it("throws error if transaction XDR is empty or invalid", async () => {
      await expect(submitTransaction("")).rejects.toThrow(
        "Invalid transaction XDR"
      );
      await expect(submitTransaction(null as any)).rejects.toThrow(
        "Invalid transaction XDR"
      );
    });
  });

  describe("createTransactionBuilder", () => {
    it("returns configured TransactionBuilder with network passphrase", () => {
      const mockAccount = { accountId: () => validPublicKey } as any;
      const builder = createTransactionBuilder(mockAccount);
      expect(builder).toBeInstanceOf(StellarSdk.TransactionBuilder);
      expect((builder as any).sourceAccount).toBe(mockAccount);
      expect((builder as any).options.networkPassphrase).toBe(
        StellarSdk.Networks.TESTNET
      );
    });
  });

  describe("getCurrentBaseFee", () => {
    it("returns parsed fee when server.feeStats() succeeds", async () => {
      const server = getHorizonServer();
      (server.feeStats as any).mockResolvedValueOnce({
        max_fee: { mode: "250" },
      });

      const fee = await getCurrentBaseFee();
      expect(fee).toBe(250);
    });

    it("falls back to BASE_FEE if feeStats fails", async () => {
      const server = getHorizonServer();
      (server.feeStats as any).mockRejectedValueOnce(new Error("RPC failure"));

      const fee = await getCurrentBaseFee();
      expect(fee).toBe(100);
    });
  });

  describe("addressExists", () => {
    it("returns true when account exists", async () => {
      const server = getHorizonServer();
      (server.accounts().accountId(validPublicKey).call as any).mockResolvedValueOnce({
        id: validPublicKey,
      });

      const exists = await addressExists(validPublicKey);
      expect(exists).toBe(true);
    });

    it("returns false when account returns 404", async () => {
      const server = getHorizonServer();
      const notFoundError = new Error("Not Found") as any;
      notFoundError.status = 404;
      (server.accounts().accountId(validPublicKey).call as any).mockRejectedValueOnce(
        notFoundError
      );

      const exists = await addressExists(validPublicKey);
      expect(exists).toBe(false);
    });

    it("rethrows error when error status is not 404", async () => {
      const server = getHorizonServer();
      const serverError = new Error("Internal Server Error") as any;
      serverError.status = 500;
      (server.accounts().accountId(validPublicKey).call as any).mockRejectedValueOnce(
        serverError
      );

      await expect(addressExists(validPublicKey)).rejects.toThrow("Internal Server Error");
    });
  });

  describe("getAccountBalances", () => {
    it("returns account balances array from account info", async () => {
      const mockBalances = [
        { asset_type: "native", balance: "100.00" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "50.00" },
      ];
      const server = getHorizonServer();
      (server.accounts().accountId(validPublicKey).call as any).mockResolvedValueOnce({
        balances: mockBalances,
      });

      const balances = await getAccountBalances(validPublicKey);
      expect(balances).toEqual(mockBalances);
    });
  });
});
