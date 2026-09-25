const db = require('../models/db');
const surplusListingModel = require('../models/surplusListingModel');
const dailyLogModel = require('../models/dailyLogModel');
const organizationModel = require('../models/organizationModel');
const transactionModel = require('../models/transactionModel');
const notificationService = require('./notificationService');
const donationLedgerService = require('./donationLedgerService');
const AppError = require('../utils/AppError');
const { haversineDistanceKm } = require('../utils/distance');
const { isWithinServiceRadius } = require('../utils/serviceRadius');
const ngoMatching = require('../ai/ngoMatching');
const spoilageRisk = require('../ai/spoilageRisk');
const { ORG_TYPES, VERIFICATION_STATUS, ROLES, LISTING_STATUS, LEDGER_EVENT_TYPES } = require('../utils/constants');

// Runs the (pure) spoilage-risk estimator, turning bad input into a 400.
function assessSpoilage(input, now = new Date()) {
    try {
        return spoilageRisk.assessSpoilageRisk(input, now);
    } catch (error) {
        if (error instanceof spoilageRisk.SpoilageInputError) {
            throw new AppError(400, error.message);
        }
        throw error;
    }
}

// Creates a listing. The spoilage estimate is advisory: it never blocks a donation. If staff supply
// safeUntilTime that value is used as-is (staff override); if they omit it, the estimated safe-until
// time (derived from preparedTime) is used.
async function createListing(actingUser, payload) {
    if (payload.dailyLogId) {
        const log = await dailyLogModel.findById(payload.dailyLogId);
        if (!log) {
            throw new AppError(404, 'Daily log not found');
        }
        if (log.kitchen_org_id !== actingUser.organizationId) {
            throw new AppError(403, 'You do not have permission to perform this action');
        }
    }

    const now = new Date();
    const assessment = assessSpoilage(
        {
            foodType: payload.foodType,
            quantity: payload.quantity,
            preparedTime: payload.preparedTime,
            safeUntilTime: payload.safeUntilTime,
            ambientTemperatureC: payload.ambientTemperatureC,
        },
        now
    );

    const staffOverride = Boolean(payload.safeUntilTime);
    const safeUntilTime = staffOverride ? payload.safeUntilTime : assessment.estimatedSafeUntil;

    if (new Date(safeUntilTime).getTime() <= now.getTime()) {
        if (!staffOverride) {
            throw new AppError(
                400,
                'The estimated safe-until time has already passed. If staff have checked the food and judge it still suitable, provide safeUntilTime to set it yourself.',
                { spoilageAssessment: assessment }
            );
        }
        throw new AppError(400, 'Safe-until time must be in the future');
    }

    const listing = await db.transaction(async (client) => {
        const created = await surplusListingModel.create(
            {
                dailyLogId: payload.dailyLogId ?? null,
                kitchenOrgId: actingUser.organizationId,
                quantity: payload.quantity,
                foodType: payload.foodType,
                preparedTime: payload.preparedTime ?? null,
                safeUntilTime,
            },
            client
        );
        await donationLedgerService.recordEvent(
            {
                surplusListingId: created.id,
                eventType: LEDGER_EVENT_TYPES.SURPLUS_CREATED,
                organizationId: actingUser.organizationId,
                actorUserId: actingUser.id,
                payload: { quantity: created.quantity, foodType: created.food_type, safeUntilTime: created.safe_until_time, dailyLogId: created.daily_log_id },
            },
            client
        );
        return created;
    });

    const kitchenOrg = await organizationModel.findById(actingUser.organizationId);
    const ngoOrgIds = await findNgoOrgIdsInRange(kitchenOrg);
    await notificationService.notifySurplusPosted(listing, ngoOrgIds);

    return {
        listing,
        spoilageAssessment: {
            ...assessment,
            safeUntilSource: staffOverride ? 'staff_override' : 'estimated',
            appliedSafeUntil: new Date(safeUntilTime).toISOString(),
        },
    };
}

// Stateless preview so staff can see the estimate (and its reasons) before creating a listing.
function estimateSpoilage(payload) {
    return assessSpoilage({
        foodType: payload.foodType,
        quantity: payload.quantity,
        preparedTime: payload.preparedTime,
        safeUntilTime: payload.safeUntilTime,
        ambientTemperatureC: payload.ambientTemperatureC,
    });
}

// Assessment for a stored listing; visible only to the owning kitchen or the claiming NGO
// (same rule as viewing the listing itself). Ambient temperature is not stored, so it can be
// supplied per request; otherwise a warm temperature is assumed.
async function getListingSpoilageAssessment(actingUser, id, { ambientTemperatureC } = {}) {
    const listing = await getListingById(actingUser, id);
    const assessment = assessSpoilage({
        foodType: listing.food_type,
        quantity: listing.quantity,
        preparedTime: listing.prepared_time,
        safeUntilTime: listing.safe_until_time,
        ambientTemperatureC,
    });
    return {
        listingId: listing.id,
        ...assessment,
        appliedSafeUntil: new Date(listing.safe_until_time).toISOString(),
    };
}

async function findNgoOrgIdsInRange(kitchenOrg) {
    const ngos = await organizationModel.list({ type: ORG_TYPES.NGO, verificationStatus: VERIFICATION_STATUS.VERIFIED, limit: 1000 });
    return ngos
        .filter((ngo) => isWithinServiceRadius(kitchenOrg, ngo))
        .map((ngo) => ngo.id);
}

// Expiry is system-triggered (no acting user) rather than a request a person makes, so it is swept lazily
// here rather than exposed as its own endpoint. Each listing flipped to Expired gets its own SURPLUS_EXPIRED
// ledger entry, in the same transaction as the status change, so the two can never disagree.
async function expireStaleListingsWithLedger() {
    return db.transaction(async (client) => {
        const expired = await surplusListingModel.expireStaleListings(client);
        for (const listing of expired) {
            // eslint-disable-next-line no-await-in-loop -- each entry must be appended after the previous one for the same listing's chain
            await donationLedgerService.recordEvent(
                {
                    surplusListingId: listing.id,
                    eventType: LEDGER_EVENT_TYPES.SURPLUS_EXPIRED,
                    organizationId: listing.kitchen_org_id,
                    actorUserId: null,
                    payload: { safeUntilTime: listing.safe_until_time },
                },
                client
            );
        }
        return expired;
    });
}

async function listOwnListings(actingUser, filters) {
    await expireStaleListingsWithLedger();
    return surplusListingModel.listByKitchenOrg(actingUser.organizationId, filters);
}

async function getFeedForNgo(actingUser) {
    await expireStaleListingsWithLedger();
    const ngoOrg = await organizationModel.findById(actingUser.organizationId);
    if (!ngoOrg || ngoOrg.verification_status !== VERIFICATION_STATUS.VERIFIED) {
        throw new AppError(403, 'Your organization must be verified before viewing the surplus feed');
    }

    const listings = await surplusListingModel.listActiveForFeed();

    return listings
        .map((listing) => {
            const distanceKm = haversineDistanceKm(
                ngoOrg.latitude,
                ngoOrg.longitude,
                listing.kitchen_latitude,
                listing.kitchen_longitude
            );
            return { ...listing, distance_km: distanceKm };
        })
        .filter((listing) => {
            if (!ngoOrg.service_radius_km || listing.distance_km === null) return true;
            return listing.distance_km <= ngoOrg.service_radius_km;
        })
        .sort((a, b) => {
            if (a.distance_km === null) return 1;
            if (b.distance_km === null) return -1;
            return a.distance_km - b.distance_km;
        });
}

async function assertVisibleToActingUser(actingUser, listing) {
    // An account without an organization (e.g. a system admin) is neither the owner nor the claimer. Comparing
    // null with the null of an unclaimed listing must never count as a match.
    const orgId = actingUser.organizationId;
    const isOwningKitchen = orgId != null && listing.kitchen_org_id === orgId;
    const isClaimingNgo = orgId != null && listing.claimed_by_ngo_id === orgId;
    if (!isOwningKitchen && !isClaimingNgo) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
}

async function getListingById(actingUser, id) {
    const listing = await surplusListingModel.findById(id);
    if (!listing) {
        throw new AppError(404, 'Surplus listing not found');
    }
    await assertVisibleToActingUser(actingUser, listing);
    return listing;
}

async function claimListing(actingUser, id, { proposedPickupTime }) {
    const ngoOrg = await organizationModel.findById(actingUser.organizationId);
    if (!ngoOrg || ngoOrg.verification_status !== VERIFICATION_STATUS.VERIFIED) {
        throw new AppError(403, 'Your organization must be verified before claiming listings');
    }

    // The feed only shows an NGO listings inside its own service area, so claiming (which anyone could otherwise do
    // by guessing a listing id) follows the same rule. A missing listing falls through to the normal "no longer
    // available" answer below.
    const candidate = await surplusListingModel.findById(id);
    if (candidate) {
        const kitchenOrg = await organizationModel.findById(candidate.kitchen_org_id);
        if (kitchenOrg && !isWithinServiceRadius(kitchenOrg, ngoOrg)) {
            throw new AppError(403, "This listing is outside your organization's service area");
        }
    }

    const listing = await db.transaction(async (client) => {
        const claimed = await surplusListingModel.claim(
            id,
            { ngoOrgId: actingUser.organizationId, userId: actingUser.id, proposedPickupTime },
            client
        );
        if (!claimed) {
            throw new AppError(409, 'This listing is no longer available to claim');
        }
        await donationLedgerService.recordEvent(
            {
                surplusListingId: claimed.id,
                eventType: LEDGER_EVENT_TYPES.SURPLUS_CLAIMED,
                organizationId: actingUser.organizationId,
                actorUserId: actingUser.id,
                payload: { claimedByNgoId: claimed.claimed_by_ngo_id, proposedPickupTime: claimed.proposed_pickup_time },
            },
            client
        );
        return claimed;
    });

    await notificationService.notifyListingClaimed(listing);
    return listing;
}

async function confirmPickup(actingUser, id, { confirmedPickupTime }) {
    const listing = await db.transaction(async (client) => {
        const updated = await surplusListingModel.confirmPickup(id, actingUser.organizationId, confirmedPickupTime, client);
        if (!updated) {
            throw new AppError(404, 'Listing not found, not claimed yet, or not owned by your organization');
        }
        await donationLedgerService.recordEvent(
            {
                surplusListingId: updated.id,
                eventType: LEDGER_EVENT_TYPES.PICKUP_CONFIRMED,
                organizationId: actingUser.organizationId,
                actorUserId: actingUser.id,
                payload: { confirmedPickupTime: updated.confirmed_pickup_time },
            },
            client
        );
        return updated;
    });

    await notificationService.notifyPickupConfirmed(listing);
    return listing;
}

async function collectListing(actingUser, id, { quantityCollected }) {
    const existing = await surplusListingModel.findById(id);
    if (!existing) {
        throw new AppError(404, 'Surplus listing not found');
    }
    const allowedOrgIds = [existing.kitchen_org_id, existing.claimed_by_ngo_id].filter(Boolean);
    if (!allowedOrgIds.includes(actingUser.organizationId)) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    // What was actually collected can never exceed what was listed: the figure feeds the rescue/impact statistics,
    // so an inflated value would fabricate meals rescued.
    if (Number(quantityCollected) > Number(existing.quantity)) {
        throw new AppError(400, 'quantityCollected cannot be more than the listed quantity');
    }

    const listing = await db.transaction(async (client) => {
        const collected = await surplusListingModel.collect(
            id,
            { collectedByUserId: actingUser.id, quantityCollected },
            allowedOrgIds,
            client
        );
        if (!collected) {
            throw new AppError(409, 'This listing is not currently claimed and cannot be collected');
        }

        await transactionModel.create(
            { surplusListingId: collected.id, collectedAt: collected.collected_at, quantityCollected },
            client
        );

        await donationLedgerService.recordEvent(
            {
                surplusListingId: collected.id,
                eventType: LEDGER_EVENT_TYPES.SURPLUS_COLLECTED,
                organizationId: actingUser.organizationId,
                actorUserId: actingUser.id,
                payload: { collectedByUserId: actingUser.id, quantityCollected },
            },
            client
        );

        return collected;
    });

    await notificationService.notifyListingCollected(listing);
    return listing;
}

// Ranked NGO matches for a single listing. Only the owning kitchen or a system
// admin may view this: it surfaces other NGOs' derived reliability stats, which
// must not be exposed to NGOs browsing the feed.
async function getNgoMatchesForListing(actingUser, id) {
    await expireStaleListingsWithLedger();

    const listing = await surplusListingModel.findById(id);
    if (!listing) {
        throw new AppError(404, 'Surplus listing not found');
    }

    const isOwningKitchen = listing.kitchen_org_id === actingUser.organizationId;
    if (!isOwningKitchen && actingUser.role !== ROLES.SYSTEM_ADMIN) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }

    if (listing.status !== LISTING_STATUS.AVAILABLE) {
        throw new AppError(409, 'Only active (Available) listings can be matched to NGOs');
    }

    const kitchenOrg = await organizationModel.findById(listing.kitchen_org_id);
    return ngoMatching.getRankedMatches(listing, kitchenOrg);
}

module.exports = {
    createListing,
    estimateSpoilage,
    getListingSpoilageAssessment,
    listOwnListings,
    getFeedForNgo,
    getListingById,
    claimListing,
    confirmPickup,
    collectListing,
    getNgoMatchesForListing,
};
