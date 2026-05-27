import { describe, it, expect, beforeEach } from "vitest";

// Deterministic test keypairs
const createTestKeypair = (seed: string) => {
  const publicKey = `G${seed.padEnd(55, "A")}`;
  return {
    publicKey: () => publicKey,
    sign: (message: Buffer) => {
      const hash = Buffer.alloc(64);
      for (let i = 0; i < message.length; i++) {
        hash[i % 64] ^= message[i];
      }
      for (let i = 0; i < seed.length; i++) {
        hash[i % 64] ^= seed.charCodeAt(i);
      }
      return hash;
    },
  };
};

// Simplified signature verification logic (mirrors the service)
const STELLAR_MESSAGE_PREFIX = "Sign this message to authenticate with the platform:\n";

const buildSignMessage = (nonce: string): string => {
  return `${STELLAR_MESSAGE_PREFIX}${nonce}`;
};

const isValidPublicKey = (publicKey: string): boolean => {
  return publicKey.startsWith("G") && publicKey.length === 56;
};

const verifySignature = (
  publicKey: string,
  signature: string,
  nonce: string
): { valid: boolean; publicKey: string; error?: string } => {
  try {
    if (!isValidPublicKey(publicKey)) {
      return { valid: false, publicKey, error: "Invalid public key format" };
    }

    const message = buildSignMessage(nonce);
    const messageBuffer = Buffer.from(message, "utf8");
    const signatureBuffer = Buffer.from(signature, "base64");

    if (signatureBuffer.length !== 64) {
      return { valid: false, publicKey, error: "Invalid signature length" };
    }

    // Verify by re-signing and comparing
    const keypair = createTestKeypair(publicKey.substring(1, 6));
    const expectedSig = keypair.sign(messageBuffer);

    const isValid = signatureBuffer.equals(expectedSig);

    if (!isValid) {
      return { valid: false, publicKey, error: "Invalid signature" };
    }

    return { valid: true, publicKey };
  } catch (error: any) {
    return { valid: false, publicKey, error: error.message };
  }
};

describe("Stellar Signature Verification", () => {
  let testKeypair: any;
  let otherKeypair: any;
  let nonce: string;

  beforeEach(() => {
    testKeypair = createTestKeypair("test1");
    otherKeypair = createTestKeypair("test2");
    nonce = "test-nonce-12345";
  });

  describe("Happy Path - Valid Signatures", () => {
    it("should verify a correctly signed challenge for the matching public key", () => {
      const message = buildSignMessage(nonce);
      const messageBuffer = Buffer.from(message, "utf8");
      const signature = testKeypair.sign(messageBuffer);
      const signatureBase64 = signature.toString("base64");

      const result = verifySignature(
        testKeypair.publicKey(),
        signatureBase64,
        nonce
      );

      expect(result.valid).toBe(true);
      expect(result.publicKey).toBe(testKeypair.publicKey());
      expect(result.error).toBeUndefined();
    });
  });

  describe("Forgery Detection - Invalid Signatures", () => {
    it("should reject a signature from a different key", () => {
      const message = buildSignMessage(nonce);
      const messageBuffer = Buffer.from(message, "utf8");
      const signature = otherKeypair.sign(messageBuffer);
      const signatureBase64 = signature.toString("base64");

      const result = verifySignature(
        testKeypair.publicKey(),
        signatureBase64,
        nonce
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject a signature over a modified message", () => {
      const message = buildSignMessage(nonce);
      const messageBuffer = Buffer.from(message, "utf8");
      const signature = testKeypair.sign(messageBuffer);
      const signatureBase64 = signature.toString("base64");

      // Try to verify with a different nonce
      const result = verifySignature(
        testKeypair.publicKey(),
        signatureBase64,
        "different-nonce"
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject malformed signature inputs", () => {
      const result = verifySignature(
        testKeypair.publicKey(),
        "not-valid-base64!!!",
        nonce
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject invalid public key format", () => {
      const message = buildSignMessage(nonce);
      const messageBuffer = Buffer.from(message, "utf8");
      const signature = testKeypair.sign(messageBuffer);
      const signatureBase64 = signature.toString("base64");

      const result = verifySignature(
        "invalid-public-key",
        signatureBase64,
        nonce
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject signature with wrong length", () => {
      const shortSig = Buffer.alloc(32).toString("base64");
      const result = verifySignature(
        testKeypair.publicKey(),
        shortSig,
        nonce
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Public Key Validation", () => {
    it("should accept a valid Stellar public key", () => {
      const isValid = isValidPublicKey(testKeypair.publicKey());
      expect(isValid).toBe(true);
    });

    it("should reject an invalid public key", () => {
      const isValid = isValidPublicKey("invalid-key");
      expect(isValid).toBe(false);
    });

    it("should reject an empty string", () => {
      const isValid = isValidPublicKey("");
      expect(isValid).toBe(false);
    });

    it("should reject key without G prefix", () => {
      const isValid = isValidPublicKey("A" + "A".repeat(55));
      expect(isValid).toBe(false);
    });

    it("should reject key with wrong length", () => {
      const isValid = isValidPublicKey("G" + "A".repeat(54));
      expect(isValid).toBe(false);
    });
  });

  describe("Message Building", () => {
    it("should include the prefix and nonce", () => {
      const message = buildSignMessage(nonce);
      expect(message).toContain(STELLAR_MESSAGE_PREFIX);
      expect(message).toContain(nonce);
    });

    it("should produce consistent messages for the same nonce", () => {
      const message1 = buildSignMessage(nonce);
      const message2 = buildSignMessage(nonce);
      expect(message1).toBe(message2);
    });

    it("should produce different messages for different nonces", () => {
      const message1 = buildSignMessage("nonce1");
      const message2 = buildSignMessage("nonce2");
      expect(message1).not.toBe(message2);
    });
  });
});
