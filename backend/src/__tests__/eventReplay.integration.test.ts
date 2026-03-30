/**
 * Backend Event Replay Integration Test Suite
 *
 * Feeds recorded fixture sequences through the ingestion pipeline and asserts
 * final DB projections are correct, idempotent, and stable under duplicates
 * and out-of-order delivery.
 *
 * DB-backed suites (Token, Stream, Campaign) require a live PostgreSQL instance
 * and are consistent with the existing integration test pattern in this repo.
 * Fixture-integrity suites run without any external dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  tokenLifecycleReplaySequence,
} from './fixtures/contractEvents';
import {
  governanceLifecycleReplaySequence,
} from './fixtures/governanceEvents';

// ── Fixture integrity (no DB required) ───────────────────────────────────────

describe('Fixture integrity — token lifecycle sequence', () => {
  it('is ordered by ledger', () => {
    const ledgers = tokenLifecycleReplaySequence.map(e => e.ledger);
    for (let i = 1; i < ledgers.length; i++) {
      expect(ledgers[i]).toBeGreaterThanOrEqual(ledgers[i - 1]);
    }
  });

  it('has unique transaction hashes', () => {
    const hashes = tokenLifecycleReplaySequence.map(e => e.transaction_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('has unique paging tokens', () => {
    const tokens = tokenLifecycleReplaySequence.map(e => e.paging_token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('starts with a tok_reg event', () => {
    expect(tokenLifecycleReplaySequence[0].topic[0]).toBe('tok_reg');
  });

  it('contains at least one burn event', () => {
    const burnTopics = tokenLifecycleReplaySequence
      .map(e => e.topic[0])
      .filter(t => t === 'tok_burn' || t === 'adm_burn');
    expect(burnTopics.length).toBeGreaterThan(0);
  });
});

describe('Fixture integrity — governance lifecycle sequence', () => {
  it('is ordered by ledger', () => {
    const ledgers = governanceLifecycleReplaySequence.map(e => e.ledger);
    for (let i = 1; i < ledgers.length; i++) {
      expect(ledgers[i]).toBeGreaterThanOrEqual(ledgers[i - 1]);
    }
  });

  it('has unique transaction hashes', () => {
    const hashes = governanceLifecycleReplaySequence.map(e => e.transaction_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('starts with a proposal creation event', () => {
    expect(governanceLifecycleReplaySequence[0].topic[0]).toMatch(/prop_create/);
  });

  it('contains at least one vote event', () => {
    const voteEvents = governanceLifecycleReplaySequence.filter(e =>
      e.topic[0].includes('vote')
    );
    expect(voteEvents.length).toBeGreaterThan(0);
  });

  it('ends with an execution or status event', () => {
    const last = governanceLifecycleReplaySequence[governanceLifecycleReplaySequence.length - 1];
    expect(last.topic[0]).toMatch(/exec|status|prop_exec|prop_status/);
  });
});

// ── Token parser replay (requires live DB) ────────────────────────────────────

describe('Token lifecycle replay', () => {
  const TOKEN = 'CREPLAY_TOKEN_LIFECYCLE_001';
  const CREATOR = 'GREPLAY_CREATOR_001';
  const HOLDER = 'GREPLAY_HOLDER_001';
  const TX_CREATE = 'tx-replay-tok-create-001';
  const TX_SELF_BURN = 'tx-replay-tok-burn-001';
  const TX_ADMIN_BURN = 'tx-replay-adm-burn-001';

  let prisma: any;
  let parser: any;

  beforeEach(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { TokenEventParser } = await import('../services/tokenEventParser');
    prisma = new PrismaClient();
    parser = new TokenEventParser(prisma);
    await prisma.burnRecord.deleteMany({ where: { token: { address: TOKEN } } });
    await prisma.token.deleteMany({ where: { address: TOKEN } });
  });

  afterEach(async () => {
    await prisma?.$disconnect();
  });

  const sequence = [
    { type: 'tok_reg' as const, tokenAddress: TOKEN, transactionHash: TX_CREATE, ledger: 2000,
      creator: CREATOR, name: 'Replay Token', symbol: 'RPL', decimals: 7, initialSupply: '1000000000000' },
    { type: 'tok_burn' as const, tokenAddress: TOKEN, transactionHash: TX_SELF_BURN, ledger: 2001,
      from: HOLDER, burner: HOLDER, amount: '100000000' },
    { type: 'adm_burn' as const, tokenAddress: TOKEN, transactionHash: TX_ADMIN_BURN, ledger: 2002,
      from: HOLDER, admin: CREATOR, amount: '200000000' },
  ];

  it('produces correct final projection after full sequence', async () => {
    for (const event of sequence) await parser.parseEvent(event);

    const token = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(token.initialSupply).toBe(BigInt('1000000000000'));
    expect(token.totalBurned).toBe(BigInt('300000000'));
    expect(token.burnCount).toBe(2);
    expect(token.totalSupply).toBe(BigInt('1000000000000') - BigInt('300000000'));
  });

  it('is idempotent — replaying the full sequence twice yields the same state', async () => {
    for (const event of sequence) await parser.parseEvent(event);
    for (const event of sequence) await parser.parseEvent(event);

    const token = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(token.burnCount).toBe(2);
    expect(token.totalBurned).toBe(BigInt('300000000'));

    const records = await prisma.burnRecord.findMany({ where: { token: { address: TOKEN } } });
    expect(records).toHaveLength(2);
  });

  it('is idempotent — duplicate events in the same batch do not drift', async () => {
    const withDuplicates = [...sequence, sequence[1], sequence[2]];
    for (const event of withDuplicates) await parser.parseEvent(event);

    const token = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(token.burnCount).toBe(2);
    expect(token.totalBurned).toBe(BigInt('300000000'));
  });

  it('handles out-of-order delivery — burn before create is skipped safely', async () => {
    await parser.parseEvent(sequence[1]); // self-burn with no token row yet
    await parser.parseEvent(sequence[0]); // create
    await parser.parseEvent(sequence[1]); // replay burn now that token exists

    const token = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(token.burnCount).toBe(1);
    expect(token.totalBurned).toBe(BigInt('100000000'));
  });
});

// ── Stream / Vault lifecycle replay (requires live DB) ───────────────────────

describe('Stream (vault) lifecycle replay', () => {
  const STREAM_ID = 9001;
  const CREATOR = 'GREPLAY_VAULT_CREATOR_001';
  const RECIPIENT = 'GREPLAY_VAULT_RECIPIENT_001';

  let prisma: any;
  let parser: any;

  beforeEach(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { StreamEventParser } = await import('../services/streamEventParser');
    prisma = new PrismaClient();
    parser = new StreamEventParser(prisma);
    await prisma.stream.deleteMany({ where: { streamId: STREAM_ID } });
  });

  afterEach(async () => {
    await prisma?.$disconnect();
  });

  const createdEvent = {
    type: 'created' as const,
    streamId: STREAM_ID,
    creator: CREATOR,
    recipient: RECIPIENT,
    amount: '5000000000',
    hasMetadata: false,
    txHash: 'tx-replay-vault-create-001',
    timestamp: new Date('2026-03-10T10:00:00Z'),
  };

  const claimedEvent = {
    type: 'claimed' as const,
    streamId: STREAM_ID,
    recipient: RECIPIENT,
    amount: '5000000000',
    txHash: 'tx-replay-vault-claim-001',
    timestamp: new Date('2026-03-10T12:00:00Z'),
  };

  it('projects create → claim correctly', async () => {
    await parser.parseEvent(createdEvent);
    await parser.parseEvent(claimedEvent);

    const stream = await prisma.stream.findUniqueOrThrow({ where: { streamId: STREAM_ID } });
    expect(stream.status).toBe('CLAIMED');
    expect(stream.creator).toBe(CREATOR);
    expect(stream.amount).toBe(BigInt('5000000000'));
  });

  it('is idempotent — replaying create does not overwrite claimed status', async () => {
    await parser.parseEvent(createdEvent);
    await parser.parseEvent(claimedEvent);
    await parser.parseEvent(createdEvent); // replay create after claim

    const stream = await prisma.stream.findUniqueOrThrow({ where: { streamId: STREAM_ID } });
    expect(stream.status).toBe('CLAIMED');
  });

  it('is idempotent — replaying the full sequence twice yields the same state', async () => {
    for (const e of [createdEvent, claimedEvent]) await parser.parseEvent(e);
    for (const e of [createdEvent, claimedEvent]) await parser.parseEvent(e);

    const stream = await prisma.stream.findUniqueOrThrow({ where: { streamId: STREAM_ID } });
    expect(stream.status).toBe('CLAIMED');
  });

  it('handles create → cancel lifecycle', async () => {
    const cancelledEvent = {
      type: 'cancelled' as const,
      streamId: STREAM_ID,
      creator: CREATOR,
      refundAmount: '5000000000',
      txHash: 'tx-replay-vault-cancel-001',
      timestamp: new Date('2026-03-10T11:00:00Z'),
    };

    await parser.parseEvent(createdEvent);
    await parser.parseEvent(cancelledEvent);

    const stream = await prisma.stream.findUniqueOrThrow({ where: { streamId: STREAM_ID } });
    expect(stream.status).toBe('CANCELLED');
  });
});

// ── Campaign lifecycle replay (requires live DB) ──────────────────────────────

describe('Campaign lifecycle replay', () => {
  const CAMPAIGN_ID = 7001;
  const TOKEN_ID = 'CREPLAY_CAMPAIGN_TOKEN_001';
  const CREATOR = 'GREPLAY_CAMPAIGN_CREATOR_001';
  const EXECUTOR = 'GREPLAY_CAMPAIGN_EXECUTOR_001';
  const TX_CREATE = 'tx-replay-camp-create-001';
  const TX_EXEC_1 = 'tx-replay-camp-exec-001';
  const TX_EXEC_2 = 'tx-replay-camp-exec-002';

  let prisma: any;
  let parser: any;

  beforeEach(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { CampaignEventParser } = await import('../services/campaignEventParser');
    prisma = new PrismaClient();
    parser = new CampaignEventParser();
    await prisma.campaignExecution.deleteMany({
      where: { campaign: { campaignId: CAMPAIGN_ID } },
    });
    await prisma.campaign.deleteMany({ where: { campaignId: CAMPAIGN_ID } });
  });

  afterEach(async () => {
    await prisma?.$disconnect();
  });

  const campaignCreated = {
    campaignId: CAMPAIGN_ID,
    tokenId: TOKEN_ID,
    creator: CREATOR,
    type: 'BUYBACK' as const,
    targetAmount: BigInt('10000000000'),
    startTime: new Date('2026-03-10T00:00:00Z'),
    txHash: TX_CREATE,
  };

  const exec1 = {
    campaignId: CAMPAIGN_ID,
    executor: EXECUTOR,
    amount: BigInt('1000000000'),
    txHash: TX_EXEC_1,
    executedAt: new Date('2026-03-10T01:00:00Z'),
  };

  const exec2 = {
    campaignId: CAMPAIGN_ID,
    executor: EXECUTOR,
    amount: BigInt('2000000000'),
    txHash: TX_EXEC_2,
    executedAt: new Date('2026-03-10T02:00:00Z'),
  };

  it('projects create → two executions correctly', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignExecution(exec1);
    await parser.parseCampaignExecution(exec2);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { campaignId: CAMPAIGN_ID } });
    expect(campaign.executionCount).toBe(2);
    expect(campaign.currentAmount).toBe(BigInt('3000000000'));
  });

  it('is idempotent — replaying executions does not double-count', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignExecution(exec1);
    await parser.parseCampaignExecution(exec2);
    await parser.parseCampaignExecution(exec1); // replay
    await parser.parseCampaignExecution(exec2); // replay

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { campaignId: CAMPAIGN_ID } });
    expect(campaign.executionCount).toBe(2);
    expect(campaign.currentAmount).toBe(BigInt('3000000000'));
  });

  it('is idempotent — replaying create does not reset execution counts', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignExecution(exec1);
    await parser.parseCampaignCreated(campaignCreated); // replay create

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { campaignId: CAMPAIGN_ID } });
    expect(campaign.executionCount).toBe(1);
    expect(campaign.currentAmount).toBe(BigInt('1000000000'));
  });

  it('status transition to COMPLETED is stable under replay', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignStatusChange({ campaignId: CAMPAIGN_ID, status: 'COMPLETED', txHash: 'tx-status-001' });
    await parser.parseCampaignStatusChange({ campaignId: CAMPAIGN_ID, status: 'COMPLETED', txHash: 'tx-status-001' });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { campaignId: CAMPAIGN_ID } });
    expect(campaign.status).toBe('COMPLETED');
  });
});
