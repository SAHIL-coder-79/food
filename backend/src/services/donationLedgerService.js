const donationLedgerModel = require('../models/donationLedgerModel');
const surplusListingModel = require('../models/surplusListingModel');
const hashChain = require('../utils/hashChain');
const AppError = require('../utils/AppError');
const { assertListingVisible } = require('../utils/listingAccess');

// Appends one event to a listing's ledger chain. Must be called with a `client` that is inside the SAME
// database transaction as the surplus-lifecycle write it documents (see surplusListingService), so that if
// the ledger insert fails for any reason, the whole transaction rolls back and the lifecycle write is
// undone too - the ledger can never silently fall behind the state it is meant to be auditing, and the
// lifecycle write can never "succeed" without leaving an audit trail.
//
// organizationId records the organization that performed the event (the kitchen for creation/pickup
// confirmation/expiry, the NGO for claiming; either, per collectListing's own rule, for collection).
// actorUserId is the acting user where one exists (null for the system-triggered SURPLUS_EXPIRED event).
async function recordEvent({ surplusListingId, eventType, organizationId, actorUserId = null, payload = {} }, client) {
    const last = await donationLedgerModel.getLastEntry(surplusListingId, client);
    const sequenceNumber = last ? last.sequenceNumber + 1 : 1;
    const previousHash = last ? last.entryHash : hashChain.GENESIS_HASH;
    const eventTimestamp = new Date().toISOString();

    const entryHash = hashChain.computeEntryHash({
        surplusListingId,
        sequenceNumber,
        eventType,
        organizationId,
        actorUserId,
        eventTimestamp,
        payload,
        previousHash,
    });

    try {
        return await donationLedgerModel.insertEntry(
            { surplusListingId, sequenceNumber, eventType, organizationId, actorUserId, eventTimestamp, payload, previousHash, entryHash },
            client
        );
    } catch (error) {
        if (error && error.code === '23505') {
            // Either the same lifecycle event happened twice for this listing (e.g. confirming pickup twice),
            // or two concurrent requests raced to append the next entry - neither should be recorded as a
            // second event.
            throw new AppError(409, 'This lifecycle event has already been recorded for this donation.');
        }
        throw error;
    }
}

// Org-scoped, read-only view of a listing's full ledger plus its chain-verification result. Access follows
// the exact same rule as viewing the listing itself (owning kitchen or claiming NGO only) - a listing that
// does not exist, or belongs to neither, is refused before any ledger row is touched.
async function getLedger(actingUser, listingId) {
    const listing = await surplusListingModel.findById(listingId);
    if (!listing) {
        throw new AppError(404, 'Surplus listing not found');
    }
    assertListingVisible(actingUser, listing);

    const entries = await donationLedgerModel.listByListing(listingId);
    const verification = hashChain.verifyChain(entries);

    return {
        listingId: listing.id,
        events: entries,
        eventCount: verification.eventCount,
        firstHash: verification.firstHash,
        lastHash: verification.lastHash,
        chainVerification: verification,
    };
}

// The dedicated /verify endpoint's shape, per Task 17: a compact, standalone verification result.
// Organization ownership is enforced as an access-control precondition (assertListingVisible) rather than
// as a field inside the result - you cannot ask for a verification of a donation you cannot see at all.
async function verifyLedger(actingUser, listingId) {
    const listing = await surplusListingModel.findById(listingId);
    if (!listing) {
        throw new AppError(404, 'Surplus listing not found');
    }
    assertListingVisible(actingUser, listing);

    const entries = await donationLedgerModel.listByListing(listingId);
    const verification = hashChain.verifyChain(entries);

    return {
        valid: verification.valid,
        eventCount: verification.eventCount,
        verifiedAt: new Date().toISOString(),
        firstHash: verification.firstHash,
        lastHash: verification.lastHash,
        ...(verification.valid ? {} : { brokenAtSequence: verification.brokenAtSequence, reason: verification.reason }),
    };
}

module.exports = { recordEvent, getLedger, verifyLedger };
