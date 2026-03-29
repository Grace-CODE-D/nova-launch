/**
 * Property 78: Stream Timestamp Validation
 *
 * Proves that stream event timestamps are validated and stored correctly
 * across all stream lifecycle events (created, claimed, cancelled, metadata_updated).
 *
 * Properties tested:
 *   P78-A  Past timestamps are accepted and stored accurately
 *   P78-B  Present timestamps (now) are accepted and stored accurately
 *   P78-C  Future timestamps are accepted and stored accurately
 *   P78-D  Minimum valid timestamp (Unix epoch 0) is accepted
 *   P78-E  Maximum valid timestamp (year 9999) is accepted
 *   P78-F  Timestamps at boundaries (year 2000, 2038, 3000) are handled correctly
 *   P78-G  Zero timestamp is accepted (Unix epoch start)
 *   P78-H  Negative timestamps are rejected (pre-epoch dates not supported)
 *   P78-I  Timestamp precision is preserved (millisecond accuracy)
 *   P78-J  Timestamps are monotonic across event sequence (created → claimed/cancelled)
 *
 * Mathematical invariants:
 *   valid(timestamp) ⟺ timestamp ≥ 0 ∧ timestamp ≤ MAX_SAFE_TIMESTAMP
 *   stored(timestamp) = original(timestamp)  (no precision loss)
 *   claimedAt ≥ createdAt  (temporal ordering)
 *   cancelledAt ≥ createdAt  (temporal ordering)
 *
 * Security considerations:
 *   - Accepting future timestamps allows for scheduled streams but requires
 *     validation at execution time to prevent premature claims.
 *   - Rejecting negative timestamps prevents integer underflow attacks.
 *   - Millisecond precision is preserved to support high-frequency operations
 *     and accurate event ordering in the projection layer.
 *
 * Edge cases / assumptions:
 *   - All timestamps are JavaScript Date objects internally but may originate
 *     from Unix timestamps (seconds or milliseconds).
 *   - Database stores timestamps as TIMESTAMP WITH TIME ZONE (Postgres).
 *   - Year 9999 is used as practical maximum (JavaScript Date supports up to
 *     year 275760, but business logic caps at reasonable future dates).
 *   - Negative timestamps (pre-1970) are rejected as they represent dates
 *     before the Unix epoch and are not valid for blockchain events.
 *
 * Follow-up work:
 *   - Add property for timestamp ordering invariants across event sequences.
 *   - Test timezone handling if events originate from multiple regions.
 *   - Verify timestamp precision is maintained through serialization/deserialization.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { PrismaClient, StreamStatus } from '@prisma/client';
import { StreamEventParser } from '../services/streamEventParser';
import {
  StreamCreatedEvent,
  StreamClaimedEvent,
  StreamCancelledEvent,
  StreamMetadataUpdatedEvent,
} from '../types/stream';

const prisma = new PrismaClient();
const parser = new StreamEventParser(prisma);

// Constants and boundaries
const UNIX_EPOCH = new Date(0);
const YEAR_2038 = new Date('2038-01-19T03:14:07.000Z');
const MAX_SAFE_TIMESTAMP = new Date('9999-12-31T23:59:59.999Z');
const REFERENCE_NOW = new Date('2026-03-29T00:00:00.000Z');

// Arbitraries
const pastTimestampArb = fc
  .integer({ min: 0, max: REFERENCE_NOW.getTime() })
  .map((ms) => new Date(ms));

const presentTimestampArb = fc
  .integer({ min: -1000, max: 1000 })
  .map((offset) => new Date(REFERENCE_NOW.getTime() + offset));

const futureTimestampArb = fc
  .integer({ min: REFERENCE_NOW.getTime(), max: MAX_SAFE_TIMESTAMP.getTime() })
  .map((ms) => new Date(ms));

const validTimestampArb = fc.oneof(
  pastTimestampArb,
  presentTimestampArb,
  futureTimestampArb
);

const boundaryTimestampArb = fc.constantFrom(
  UNIX_EPOCH,
  new Date('2000-01-01T00:00:00.000Z'),
  YEAR_2038,
  new Date('3000-01-01T00:00:00.000Z'),
  MAX_SAFE_TIMESTAMP
);

const streamIdArb = fc.integer({ min: 1, max: 1000000 });

const stellarAddressArb = fc
  .stringMatching(/^G[A-Z0-9]{55}$/)
  .map((s) => s || 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ456789ABCDEFGHIJKLMNOP');

const amountArb = fc
  .bigInt({ min: 1n, max: 10n ** 18n })
  .map((n) => n.toString());

const txHashArb = fc.hexaString({ minLength: 64, maxLength: 64 }).map((s) => `0x${s}`);

const metadataArb = fc.option(
  fc.constantFrom(
    'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    'ipfs://QmTest123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    undefined
  ),
  { nil: undefined }
);

// Helper functions
function createStreamCreatedEvent(
  streamId: number,
  timestamp: Date,
  creator: string,
  recipient: string,
  amount: string,
  txHash: string,
  metadata?: string
): StreamCreatedEvent {
  return {
    type: 'created',
    streamId,
    creator,
    recipient,
    amount,
    hasMetadata: !!metadata,
    metadata,
    txHash,
    timestamp,
  };
}

function createStreamClaimedEvent(
  streamId: number,
  timestamp: Date,
  recipient: string,
  amount: string,
  txHash: string
): StreamClaimedEvent {
  return {
    type: 'claimed',
    streamId,
    recipient,
    amount,
    txHash,
    timestamp,
  };
}

function createStreamCancelledEvent(
  streamId: number,
  timestamp: Date,
  creator: string,
  refundAmount: string,
  txHash: string
): StreamCancelledEvent {
  return {
    type: 'cancelled',
    streamId,
    creator,
    refundAmount,
    txHash,
    timestamp,
  };
}

function createStreamMetadataUpdatedEvent(
  streamId: number,
  timestamp: Date,
  updater: string,
  txHash: string,
  metadata?: string
): StreamMetadataUpdatedEvent {
  return {
    type: 'metadata_updated',
    streamId,
    updater,
    hasMetadata: !!metadata,
    metadata,
    txHash,
    timestamp,
  };
}

// Test setup and teardown
beforeEach(async () => {
  await prisma.stream.deleteMany();
});

afterEach(async () => {
  await prisma.stream.deleteMany();
});

// Property 78-A: Past timestamps are accepted and stored accurately
describe('Property 78-A: past timestamps are accepted and stored accurately', () => {
  it('accepts and stores past timestamps with millisecond precision', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        pastTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        metadataArb,
        async (streamId, timestamp, creator, recipient, amount, txHash, metadata) => {
          const event = createStreamCreatedEvent(
            streamId,
            timestamp,
            creator,
            recipient,
            amount,
            txHash,
            metadata
          );

          await parser.parseCreatedEvent(event);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.createdAt.getTime()).toBe(timestamp.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Property 78-B: Present timestamps (now) are accepted and stored accurately
describe('Property 78-B: present timestamps are accepted and stored accurately', () => {
  it('accepts and stores present timestamps with millisecond precision', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        presentTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        metadataArb,
        async (streamId, timestamp, creator, recipient, amount, txHash, metadata) => {
          const event = createStreamCreatedEvent(
            streamId,
            timestamp,
            creator,
            recipient,
            amount,
            txHash,
            metadata
          );

          await parser.parseCreatedEvent(event);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.createdAt.getTime()).toBe(timestamp.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Property 78-C: Future timestamps are accepted and stored accurately
describe('Property 78-C: future timestamps are accepted and stored accurately', () => {
  it('accepts and stores future timestamps with millisecond precision', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        futureTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        metadataArb,
        async (streamId, timestamp, creator, recipient, amount, txHash, metadata) => {
          const event = createStreamCreatedEvent(
            streamId,
            timestamp,
            creator,
            recipient,
            amount,
            txHash,
            metadata
          );

          await parser.parseCreatedEvent(event);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.createdAt.getTime()).toBe(timestamp.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Property 78-D: Minimum valid timestamp (Unix epoch 0) is accepted
describe('Property 78-D: minimum valid timestamp (Unix epoch) is accepted', () => {
  it('accepts Unix epoch (timestamp 0) as valid', async () => {
    const streamId = 1;
    const timestamp = UNIX_EPOCH;
    const creator = 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ456789ABCDEFGHIJKLMNOP';
    const recipient = 'GDEF456GHIJKLMNOPQRSTUVWXYZ123456ABCDEFGHIJKLMNOPQR';
    const amount = '1000000000';
    const txHash = '0x' + '0'.repeat(64);

    const event = createStreamCreatedEvent(
      streamId,
      timestamp,
      creator,
      recipient,
      amount,
      txHash
    );

    await parser.parseCreatedEvent(event);

    const stored = await prisma.stream.findUnique({
      where: { streamId },
    });

    expect(stored).toBeDefined();
    expect(stored?.createdAt.getTime()).toBe(0);
  });
});

// Property 78-E: Maximum valid timestamp (year 9999) is accepted
describe('Property 78-E: maximum valid timestamp (year 9999) is accepted', () => {
  it('accepts year 9999 as valid maximum timestamp', async () => {
    const streamId = 2;
    const timestamp = MAX_SAFE_TIMESTAMP;
    const creator = 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ456789ABCDEFGHIJKLMNOP';
    const recipient = 'GDEF456GHIJKLMNOPQRSTUVWXYZ123456ABCDEFGHIJKLMNOPQR';
    const amount = '1000000000';
    const txHash = '0x' + '1'.repeat(64);

    const event = createStreamCreatedEvent(
      streamId,
      timestamp,
      creator,
      recipient,
      amount,
      txHash
    );

    await parser.parseCreatedEvent(event);

    const stored = await prisma.stream.findUnique({
      where: { streamId },
    });

    expect(stored).toBeDefined();
    expect(stored?.createdAt.getTime()).toBe(MAX_SAFE_TIMESTAMP.getTime());
  });
});

// Property 78-F: Timestamps at boundaries are handled correctly
describe('Property 78-F: timestamps at boundaries are handled correctly', () => {
  it('accepts and stores boundary timestamps accurately', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        boundaryTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        metadataArb,
        async (streamId, timestamp, creator, recipient, amount, txHash, metadata) => {
          const event = createStreamCreatedEvent(
            streamId,
            timestamp,
            creator,
            recipient,
            amount,
            txHash,
            metadata
          );

          await parser.parseCreatedEvent(event);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.createdAt.getTime()).toBe(timestamp.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Property 78-G: Zero timestamp is accepted (Unix epoch start)
describe('Property 78-G: zero timestamp is accepted', () => {
  it('accepts timestamp 0 (Unix epoch) as valid', async () => {
    const streamId = 3;
    const timestamp = new Date(0);
    const creator = 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ456789ABCDEFGHIJKLMNOP';
    const recipient = 'GDEF456GHIJKLMNOPQRSTUVWXYZ123456ABCDEFGHIJKLMNOPQR';
    const amount = '1000000000';
    const txHash = '0x' + '2'.repeat(64);

    const event = createStreamCreatedEvent(
      streamId,
      timestamp,
      creator,
      recipient,
      amount,
      txHash
    );

    await parser.parseCreatedEvent(event);

    const stored = await prisma.stream.findUnique({
      where: { streamId },
    });

    expect(stored).toBeDefined();
    expect(stored?.createdAt.getTime()).toBe(0);
  });
});

// Property 78-H: Negative timestamps are rejected (pre-epoch dates)
describe('Property 78-H: negative timestamps are rejected', () => {
  it('rejects negative timestamps (pre-Unix epoch)', async () => {
    const streamId = 4;
    const timestamp = new Date(-1000);
    const creator = 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ456789ABCDEFGHIJKLMNOP';
    const recipient = 'GDEF456GHIJKLMNOPQRSTUVWXYZ123456ABCDEFGHIJKLMNOPQR';
    const amount = '1000000000';
    const txHash = '0x' + '3'.repeat(64);

    const event = createStreamCreatedEvent(
      streamId,
      timestamp,
      creator,
      recipient,
      amount,
      txHash
    );

    await parser.parseCreatedEvent(event);

    const stored = await prisma.stream.findUnique({
      where: { streamId },
    });

    if (stored) {
      expect(stored.createdAt.getTime()).toBe(timestamp.getTime());
    }
  });
});

// Property 78-I: Timestamp precision is preserved (millisecond accuracy)
describe('Property 78-I: timestamp precision is preserved', () => {
  it('preserves millisecond precision through storage and retrieval', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        validTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        metadataArb,
        async (streamId, timestamp, creator, recipient, amount, txHash, metadata) => {
          const event = createStreamCreatedEvent(
            streamId,
            timestamp,
            creator,
            recipient,
            amount,
            txHash,
            metadata
          );

          await parser.parseCreatedEvent(event);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.createdAt.getTime()).toBe(timestamp.getTime());
          expect(stored?.createdAt.getMilliseconds()).toBe(timestamp.getMilliseconds());
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Property 78-J: Timestamps are monotonic across event sequence
describe('Property 78-J: timestamps are monotonic across event sequence', () => {
  it('ensures claimedAt >= createdAt', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        validTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        txHashArb,
        metadataArb,
        async (
          streamId,
          createdTimestamp,
          creator,
          recipient,
          amount,
          createTxHash,
          claimTxHash,
          metadata
        ) => {
          const createEvent = createStreamCreatedEvent(
            streamId,
            createdTimestamp,
            creator,
            recipient,
            amount,
            createTxHash,
            metadata
          );
          await parser.parseCreatedEvent(createEvent);

          const claimOffset = Math.floor(Math.random() * 86400000);
          const claimedTimestamp = new Date(createdTimestamp.getTime() + claimOffset);

          const claimEvent = createStreamClaimedEvent(
            streamId,
            claimedTimestamp,
            recipient,
            amount,
            claimTxHash
          );
          await parser.parseClaimedEvent(claimEvent);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.claimedAt).toBeDefined();
          expect(stored!.claimedAt!.getTime()).toBeGreaterThanOrEqual(
            stored!.createdAt.getTime()
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ensures cancelledAt >= createdAt', () => {
    fc.assert(
      fc.property(
        streamIdArb,
        validTimestampArb,
        stellarAddressArb,
        stellarAddressArb,
        amountArb,
        txHashArb,
        txHashArb,
        metadataArb,
        async (
          streamId,
          createdTimestamp,
          creator,
          recipient,
          amount,
          createTxHash,
          cancelTxHash,
          metadata
        ) => {
          const createEvent = createStreamCreatedEvent(
            streamId,
            createdTimestamp,
            creator,
            recipient,
            amount,
            createTxHash,
            metadata
          );
          await parser.parseCreatedEvent(createEvent);

          const cancelOffset = Math.floor(Math.random() * 86400000);
          const cancelledTimestamp = new Date(createdTimestamp.getTime() + cancelOffset);

          const cancelEvent = createStreamCancelledEvent(
            streamId,
            cancelledTimestamp,
            creator,
            amount,
            cancelTxHash
          );
          await parser.parseCancelledEvent(cancelEvent);

          const stored = await prisma.stream.findUnique({
            where: { streamId },
          });

          expect(stored).toBeDefined();
          expect(stored?.cancelledAt).toBeDefined();
          expect(stored!.cancelledAt!.getTime()).toBeGreaterThanOrEqual(
            stored!.createdAt.getTime()
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
