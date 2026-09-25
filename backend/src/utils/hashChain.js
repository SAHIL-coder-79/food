'use strict';

const crypto = require('crypto');

// Genesis previous-hash: a fixed, clearly-not-a-real-hash value marking "no earlier event exists yet" for
// the first ledger entry of a donation. 64 hex characters, the same length as a real SHA-256 digest, so a
// genesis entry's previousHash is structurally consistent with every other entry's.
const GENESIS_HASH = '0'.repeat(64);

// Deterministic JSON serialisation: object keys are sorted recursively so the exact same logical content
// always produces the exact same bytes, regardless of the order fields were set in application code or
// however a JSONB column happens to return them.
function canonicalize(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value === undefined ? null : value);
    }
    // A raw Date (e.g. a TIMESTAMP column the pg driver returned as one, embedded in an event's payload)
    // has no own enumerable properties, so without this it would silently canonicalize to '{}' and lose the
    // value entirely. Normalising it to its ISO string keeps it identical to how it round-trips through
    // JSON.stringify when the same payload is stored as JSONB.
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',');
    return `{${body}}`;
}

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// The canonical content of one ledger entry - everything that makes the event what it is, plus the link to
// the previous entry. Deliberately excludes the database-assigned `id`/`created_at`: those are storage
// details, not part of the event itself, and would make the hash depend on insertion mechanics rather than
// on what actually happened. `eventTimestamp` is normalised to a fixed ISO-8601 string so the hash is the
// same whether it is computed just before insertion (from a JS Date) or later, during verification (from
// whatever timestamp representation the database driver returns).
function computeEntryHash({ surplusListingId, sequenceNumber, eventType, organizationId, actorUserId, eventTimestamp, payload, previousHash }) {
    const canonical = canonicalize({
        surplusListingId,
        sequenceNumber,
        eventType,
        organizationId,
        actorUserId: actorUserId ?? null,
        eventTimestamp: new Date(eventTimestamp).toISOString(),
        payload: payload ?? {},
        previousHash,
    });
    return sha256Hex(canonical);
}

// Verifies a full, already sequence-ordered chain of entries for one listing:
//   - every entry's stored hash must match what recomputing it from its own content produces
//     (detects a tampered payload or any other altered field),
//   - every entry's previousHash must equal the prior entry's entryHash
//     (detects a deleted, reordered or inserted entry),
//   - sequence numbers must be contiguous starting at 1 (detects a skipped or duplicated position).
function verifyChain(entries) {
    if (entries.length === 0) {
        return { valid: true, eventCount: 0, firstHash: null, lastHash: null, brokenAtSequence: null, reason: null };
    }

    const firstHash = entries[0].entryHash;
    const lastHash = entries[entries.length - 1].entryHash;
    const invalid = (brokenAtSequence, reason) => ({
        valid: false,
        eventCount: entries.length,
        firstHash,
        lastHash,
        brokenAtSequence,
        reason,
    });

    let expectedPrevious = GENESIS_HASH;
    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const expectedSequence = i + 1;

        if (entry.sequenceNumber !== expectedSequence) {
            return invalid(entry.sequenceNumber, `Expected sequence number ${expectedSequence} but found ${entry.sequenceNumber}`);
        }
        if (entry.previousHash !== expectedPrevious) {
            return invalid(entry.sequenceNumber, "previousHash does not match the preceding entry's hash");
        }
        if (computeEntryHash(entry) !== entry.entryHash) {
            return invalid(entry.sequenceNumber, "Stored hash does not match the entry's content (tampered or corrupted)");
        }
        expectedPrevious = entry.entryHash;
    }

    return { valid: true, eventCount: entries.length, firstHash, lastHash, brokenAtSequence: null, reason: null };
}

module.exports = { GENESIS_HASH, canonicalize, computeEntryHash, verifyChain };
