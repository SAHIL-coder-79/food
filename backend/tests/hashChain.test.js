const { GENESIS_HASH, canonicalize, computeEntryHash, verifyChain } = require('../src/utils/hashChain');

function makeEntry(overrides = {}) {
    return {
        surplusListingId: 1,
        sequenceNumber: 1,
        eventType: 'SURPLUS_CREATED',
        organizationId: 10,
        actorUserId: 100,
        eventTimestamp: '2026-01-01T00:00:00.000Z',
        payload: { quantity: 5, foodType: 'Rice' },
        previousHash: GENESIS_HASH,
        ...overrides,
    };
}

function chainNext(previousEntry, overrides) {
    const previousHash = computeEntryHash(previousEntry);
    const entry = makeEntry({
        sequenceNumber: previousEntry.sequenceNumber + 1,
        previousHash,
        ...overrides,
    });
    return { ...entry, entryHash: computeEntryHash(entry) };
}

describe('canonicalize', () => {
    it('produces identical output for objects with the same content in a different key order', () => {
        const a = canonicalize({ b: 2, a: 1, c: { y: 2, x: 1 } });
        const b = canonicalize({ a: 1, c: { x: 1, y: 2 }, b: 2 });
        expect(a).toBe(b);
    });

    it('treats undefined the same as null (JSON has no undefined)', () => {
        expect(canonicalize(undefined)).toBe(canonicalize(null));
    });

    it('serialises arrays in order (order is significant for arrays, unlike object keys)', () => {
        expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
        expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
    });

    it('serialises a raw Date (e.g. a TIMESTAMP column pg returns as one) to its ISO string, not "{}"', () => {
        const date = new Date('2026-01-01T00:00:00.000Z');
        expect(canonicalize(date)).toBe('"2026-01-01T00:00:00.000Z"');
        expect(canonicalize({ safeUntilTime: date })).toBe(canonicalize({ safeUntilTime: '2026-01-01T00:00:00.000Z' }));
    });
});

describe('computeEntryHash', () => {
    it('is deterministic: the same content always produces the same hash', () => {
        const entry = makeEntry();
        expect(computeEntryHash(entry)).toBe(computeEntryHash(entry));
        expect(computeEntryHash(makeEntry())).toBe(computeEntryHash(makeEntry()));
    });

    it('normalises eventTimestamp representation, so a Date and its equivalent ISO string hash the same', () => {
        const asString = makeEntry({ eventTimestamp: '2026-01-01T00:00:00.000Z' });
        const asDate = makeEntry({ eventTimestamp: new Date('2026-01-01T00:00:00.000Z') });
        expect(computeEntryHash(asString)).toBe(computeEntryHash(asDate));
    });

    it('changes if any field changes (payload, eventType, organizationId, actorUserId, previousHash)', () => {
        const base = computeEntryHash(makeEntry());
        expect(computeEntryHash(makeEntry({ payload: { quantity: 6, foodType: 'Rice' } }))).not.toBe(base);
        expect(computeEntryHash(makeEntry({ eventType: 'SURPLUS_CLAIMED' }))).not.toBe(base);
        expect(computeEntryHash(makeEntry({ organizationId: 99 }))).not.toBe(base);
        expect(computeEntryHash(makeEntry({ actorUserId: 999 }))).not.toBe(base);
        expect(computeEntryHash(makeEntry({ previousHash: '1'.repeat(64) }))).not.toBe(base);
    });

    it('treats a missing actorUserId as null, not as a distinct "undefined" hash input', () => {
        const withNull = makeEntry({ actorUserId: null });
        const withUndefined = makeEntry();
        delete withUndefined.actorUserId;
        expect(computeEntryHash(withNull)).toBe(computeEntryHash(withUndefined));
    });

    it('produces a 64-character lowercase hex string (a real SHA-256 digest)', () => {
        const hash = computeEntryHash(makeEntry());
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('verifyChain - genesis and linkage', () => {
    it('the first entry of a chain must use the fixed genesis previousHash', () => {
        const first = makeEntry({ previousHash: GENESIS_HASH });
        const entryHash = computeEntryHash(first);
        const result = verifyChain([{ ...first, entryHash }]);
        expect(result.valid).toBe(true);
        expect(result.eventCount).toBe(1);
        expect(result.firstHash).toBe(entryHash);
        expect(result.lastHash).toBe(entryHash);
    });

    it('a second entry must link its previousHash to the first entry\'s own hash', () => {
        const first = { ...makeEntry(), };
        first.entryHash = computeEntryHash(first);
        const second = chainNext(first, { eventType: 'SURPLUS_CLAIMED' });

        const result = verifyChain([first, second]);
        expect(result.valid).toBe(true);
        expect(result.eventCount).toBe(2);
        expect(second.previousHash).toBe(first.entryHash);
        expect(result.firstHash).toBe(first.entryHash);
        expect(result.lastHash).toBe(second.entryHash);
    });

    it('an empty chain (no events yet) is trivially valid with zero events', () => {
        const result = verifyChain([]);
        expect(result).toEqual({ valid: true, eventCount: 0, firstHash: null, lastHash: null, brokenAtSequence: null, reason: null });
    });
});

describe('verifyChain - tamper detection', () => {
    it('detects a tampered payload (stored hash no longer matches recomputed content)', () => {
        const first = makeEntry();
        first.entryHash = computeEntryHash(first);
        const tampered = { ...first, payload: { quantity: 999, foodType: 'Rice' } }; // hash left as-is: not recomputed

        const result = verifyChain([tampered]);
        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(1);
        expect(result.reason).toMatch(/tampered or corrupted/i);
    });

    it('detects a tampered eventType the same way', () => {
        const first = makeEntry();
        first.entryHash = computeEntryHash(first);
        const tampered = { ...first, eventType: 'SURPLUS_COLLECTED' };
        expect(verifyChain([tampered]).valid).toBe(false);
    });

    it('detects a broken previousHash link between two otherwise-valid entries', () => {
        const first = makeEntry();
        first.entryHash = computeEntryHash(first);
        const second = chainNext(first, { eventType: 'SURPLUS_CLAIMED' });
        second.previousHash = 'f'.repeat(64); // does not match first.entryHash, but second.entryHash is left stale

        const result = verifyChain([first, second]);
        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(2);
        expect(result.reason).toMatch(/previousHash/);
    });

    it('detects out-of-order / skipped sequence numbers', () => {
        const first = makeEntry({ sequenceNumber: 1 });
        first.entryHash = computeEntryHash(first);
        const skipped = makeEntry({ sequenceNumber: 3, previousHash: first.entryHash });
        skipped.entryHash = computeEntryHash(skipped);

        const result = verifyChain([first, skipped]);
        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(3);
        expect(result.reason).toMatch(/sequence number/i);
    });

    it('a chain of several genuine events verifies as valid end to end', () => {
        const created = makeEntry({ eventType: 'SURPLUS_CREATED' });
        created.entryHash = computeEntryHash(created);
        const claimed = chainNext(created, { eventType: 'SURPLUS_CLAIMED' });
        const confirmed = chainNext(claimed, { eventType: 'PICKUP_CONFIRMED' });
        const collected = chainNext(confirmed, { eventType: 'SURPLUS_COLLECTED' });

        const result = verifyChain([created, claimed, confirmed, collected]);
        expect(result.valid).toBe(true);
        expect(result.eventCount).toBe(4);
        expect(result.firstHash).toBe(created.entryHash);
        expect(result.lastHash).toBe(collected.entryHash);
    });
});
