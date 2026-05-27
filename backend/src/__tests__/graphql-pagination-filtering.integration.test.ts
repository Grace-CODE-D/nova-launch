/**
 * GraphQL Pagination, Filtering, and Ordering Integration Tests
 *
 * Validates cursor pagination, filter predicates, and ordering return correct,
 * stable results against a seeded dataset.
 *
 * Strategy:
 *   - Seed a known dataset of tokens, streams, and campaigns
 *   - Assert forward pagination returns non-overlapping pages
 *   - Assert filters narrow results correctly
 *   - Assert ordering is stable and matches the requested sort
 *   - Cover empty result sets and single-page results
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { graphql } from "graphql";
import { buildSchema } from "graphql";
import { prisma } from "../lib/prisma";
import { typeDefs } from "../graphql/schema";
import { resolvers } from "../graphql/resolvers";
import { makeExecutableSchema } from "@graphql-tools/schema";

// ── Test fixtures ──────────────────────────────────────────────────────────

const seedTokens = async () => {
  const tokens = [];
  for (let i = 0; i < 15; i++) {
    const token = await prisma.token.create({
      data: {
        address: `GTOKEN_PAGINATION_TEST_${i}`,
        creator: i % 2 === 0 ? "GCREATOR_A" : "GCREATOR_B",
        name: `Token ${String(i).padStart(2, "0")}`,
        symbol: `TK${i}`,
        decimals: 7,
        totalSupply: BigInt((i + 1) * 1000000),
        initialSupply: BigInt((i + 1) * 1000000),
        totalBurned: BigInt(0),
        burnCount: 0,
        metadataUri: i % 3 === 0 ? `ipfs://QmToken${i}` : null,
      },
    });
    tokens.push(token);
  }
  return tokens;
};

const seedStreams = async () => {
  const streams = [];
  for (let i = 0; i < 12; i++) {
    const stream = await prisma.stream.create({
      data: {
        streamId: i + 1,
        creator: `GCREATOR_${i % 3}`,
        recipient: `GRECIPIENT_${i % 4}`,
        amount: BigInt((i + 1) * 100000),
        status: ["CREATED", "CLAIMED", "CANCELLED"][i % 3],
        txHash: `stream-tx-${i}`,
        metadata: i % 2 === 0 ? `stream-meta-${i}` : null,
      },
    });
    streams.push(stream);
  }
  return streams;
};

const seedCampaigns = async () => {
  const campaigns = [];
  for (let i = 0; i < 10; i++) {
    const campaign = await prisma.campaign.create({
      data: {
        campaignId: i + 1,
        tokenId: `GTOKEN_PAGINATION_TEST_${i % 5}`,
        creator: `GCAMPAIGN_CREATOR_${i % 2}`,
        type: ["BUYBACK", "AIRDROP", "LIQUIDITY"][i % 3],
        status: ["ACTIVE", "PAUSED", "COMPLETED"][i % 3],
        targetAmount: BigInt((i + 1) * 500000),
        currentAmount: BigInt((i + 1) * 250000),
        executionCount: i,
        startTime: new Date(Date.now() - i * 86400000),
        endTime: new Date(Date.now() + (10 - i) * 86400000),
        txHash: `campaign-tx-${i}`,
        metadata: `campaign-meta-${i}`,
      },
    });
    campaigns.push(campaign);
  }
  return campaigns;
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GraphQL Pagination, Filtering, and Ordering", () => {
  let schema: any;

  beforeEach(async () => {
    // Build executable schema
    schema = makeExecutableSchema({
      typeDefs,
      resolvers,
    });

    // Seed test data
    await seedTokens();
    await seedStreams();
    await seedCampaigns();
  });

  afterEach(async () => {
    // Clean up
    await prisma.campaign.deleteMany({});
    await prisma.stream.deleteMany({});
    await prisma.token.deleteMany({});
  });

  describe("Token Pagination", () => {
    it("should return first page of tokens with limit", async () => {
      const query = `
        query {
          tokens(limit: 5, offset: 0) {
            id
            address
            name
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.errors).toBeUndefined();
      expect(result.data?.tokens).toHaveLength(5);
      expect(result.data?.tokens[0].name).toBe("Token 00");
    });

    it("should return non-overlapping pages", async () => {
      const query1 = `
        query {
          tokens(limit: 5, offset: 0) {
            address
          }
        }
      `;

      const query2 = `
        query {
          tokens(limit: 5, offset: 5) {
            address
          }
        }
      `;

      const result1 = await graphql({ schema, source: query1, rootValue: resolvers });
      const result2 = await graphql({ schema, source: query2, rootValue: resolvers });

      const addresses1 = result1.data?.tokens.map((t: any) => t.address);
      const addresses2 = result2.data?.tokens.map((t: any) => t.address);

      // No overlap
      expect(new Set(addresses1).intersection(new Set(addresses2)).size).toBe(0);
      expect(addresses1).toHaveLength(5);
      expect(addresses2).toHaveLength(5);
    });

    it("should respect limit cap of 100", async () => {
      const query = `
        query {
          tokens(limit: 500, offset: 0) {
            id
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.tokens.length).toBeLessThanOrEqual(100);
    });

    it("should handle empty result set", async () => {
      const query = `
        query {
          tokens(creator: "NONEXISTENT_CREATOR", limit: 10, offset: 0) {
            id
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.tokens).toEqual([]);
    });

    it("should handle single-page result", async () => {
      const query = `
        query {
          tokens(limit: 100, offset: 0) {
            id
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.tokens.length).toBeLessThanOrEqual(15);
    });
  });

  describe("Token Filtering", () => {
    it("should filter tokens by creator", async () => {
      const query = `
        query {
          tokens(creator: "GCREATOR_A", limit: 100, offset: 0) {
            creator
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.errors).toBeUndefined();
      expect(result.data?.tokens.length).toBeGreaterThan(0);
      expect(result.data?.tokens.every((t: any) => t.creator === "GCREATOR_A")).toBe(true);
    });

    it("should narrow results with filter", async () => {
      const allQuery = `
        query {
          tokens(limit: 100, offset: 0) {
            id
          }
        }
      `;

      const filteredQuery = `
        query {
          tokens(creator: "GCREATOR_A", limit: 100, offset: 0) {
            id
          }
        }
      `;

      const allResult = await graphql({ schema, source: allQuery, rootValue: resolvers });
      const filteredResult = await graphql({ schema, source: filteredQuery, rootValue: resolvers });

      expect(filteredResult.data?.tokens.length).toBeLessThan(allResult.data?.tokens.length);
    });
  });

  describe("Token Ordering", () => {
    it("should return tokens in stable order (newest first)", async () => {
      const query = `
        query {
          tokens(limit: 100, offset: 0) {
            name
            createdAt
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      const tokens = result.data?.tokens;

      // Verify descending order by createdAt
      for (let i = 0; i < tokens.length - 1; i++) {
        const current = new Date(tokens[i].createdAt).getTime();
        const next = new Date(tokens[i + 1].createdAt).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    it("should maintain stable order across multiple queries", async () => {
      const query = `
        query {
          tokens(limit: 5, offset: 0) {
            address
          }
        }
      `;

      const result1 = await graphql({ schema, source: query, rootValue: resolvers });
      const result2 = await graphql({ schema, source: query, rootValue: resolvers });

      const addresses1 = result1.data?.tokens.map((t: any) => t.address);
      const addresses2 = result2.data?.tokens.map((t: any) => t.address);

      expect(addresses1).toEqual(addresses2);
    });
  });

  describe("Stream Pagination and Filtering", () => {
    it("should paginate streams correctly", async () => {
      const query = `
        query {
          streams(limit: 4, offset: 0) {
            streamId
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.streams).toHaveLength(4);
    });

    it("should filter streams by status", async () => {
      const query = `
        query {
          streams(status: "CREATED", limit: 100, offset: 0) {
            status
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.errors).toBeUndefined();
      expect(result.data?.streams.every((s: any) => s.status === "CREATED")).toBe(true);
    });

    it("should filter streams by creator", async () => {
      const query = `
        query {
          streams(creator: "GCREATOR_0", limit: 100, offset: 0) {
            creator
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.streams.every((s: any) => s.creator === "GCREATOR_0")).toBe(true);
    });

    it("should filter streams by recipient", async () => {
      const query = `
        query {
          streams(recipient: "GRECIPIENT_0", limit: 100, offset: 0) {
            recipient
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.streams.every((s: any) => s.recipient === "GRECIPIENT_0")).toBe(true);
    });
  });

  describe("Campaign Pagination and Filtering", () => {
    it("should paginate campaigns correctly", async () => {
      const query = `
        query {
          campaigns(limit: 3, offset: 0) {
            campaignId
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.campaigns).toHaveLength(3);
    });

    it("should filter campaigns by status", async () => {
      const query = `
        query {
          campaigns(status: "ACTIVE", limit: 100, offset: 0) {
            status
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.campaigns.every((c: any) => c.status === "ACTIVE")).toBe(true);
    });

    it("should filter campaigns by type", async () => {
      const query = `
        query {
          campaigns(type: "BUYBACK", limit: 100, offset: 0) {
            type
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.campaigns.every((c: any) => c.type === "BUYBACK")).toBe(true);
    });

    it("should filter campaigns by creator", async () => {
      const query = `
        query {
          campaigns(creator: "GCAMPAIGN_CREATOR_0", limit: 100, offset: 0) {
            creator
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.campaigns.every((c: any) => c.creator === "GCAMPAIGN_CREATOR_0")).toBe(true);
    });
  });

  describe("Combined Pagination and Filtering", () => {
    it("should combine filter and pagination", async () => {
      const query = `
        query {
          tokens(creator: "GCREATOR_A", limit: 3, offset: 0) {
            creator
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.tokens.length).toBeLessThanOrEqual(3);
      expect(result.data?.tokens.every((t: any) => t.creator === "GCREATOR_A")).toBe(true);
    });

    it("should handle offset beyond dataset", async () => {
      const query = `
        query {
          tokens(limit: 10, offset: 1000) {
            id
          }
        }
      `;

      const result = await graphql({ schema, source: query, rootValue: resolvers });
      expect(result.data?.tokens).toEqual([]);
    });
  });
});
