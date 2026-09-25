'use strict';

const crypto = require('crypto');
const surplusListingModel = require('../models/surplusListingModel');
const organizationModel = require('../models/organizationModel');
const rescuePriority = require('../ai/rescuePriority');
const rescueRoutePlanner = require('../ai/rescueRoutePlanner');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const { VERIFICATION_STATUS, LISTING_STATUS } = require('../utils/constants');

function buildPlannerConfig() {
    return {
        averageSpeedKmh: env.rescueRouteAverageSpeedKmh,
        pickupServiceMinutes: env.rescueRoutePickupServiceMinutes,
        atRiskBufferMinutes: env.rescueRouteAtRiskBufferMinutes,
        urgencyTieBreakMinutes: env.rescueRouteUrgencyTieBreakMinutes,
    };
}

/**
 * Builds a deterministic rescue-route preview for a set of listings the requesting NGO has already claimed.
 * Ownership, status and coordinates are always derived from the database - listingIds is the only thing the
 * client supplies; organizationId, safe_until_time, coordinates, priority and quantity are never trusted from
 * the request body (see validators/rescueRouteValidators.js for the input shape check).
 */
async function previewRoute(actingUser, listingIds) {
    const ngoOrg = await organizationModel.findById(actingUser.organizationId);
    if (!ngoOrg || ngoOrg.verification_status !== VERIFICATION_STATUS.VERIFIED) {
        throw new AppError(403, 'Your organization must be verified before planning a rescue route');
    }

    const uniqueIds = [...new Set(listingIds.map((id) => Number(id)))];
    const found = await surplusListingModel.findByIdsWithKitchenLocation(uniqueIds);
    const byId = new Map(found.map((row) => [row.id, row]));

    // A nonexistent listing and one claimed by a different NGO are treated identically and refused with the
    // same generic reason: confirming that a listing exists but belongs to someone else would itself leak
    // information this organization has no right to see. Only a listing THIS NGO has actually claimed proceeds
    // to the more specific (and safe to disclose, since they already legitimately know about it) checks below.
    const notAvailable = uniqueIds.filter((id) => {
        const row = byId.get(id);
        return !row || row.claimed_by_ngo_id !== actingUser.organizationId;
    });
    if (notAvailable.length > 0) {
        throw new AppError(403, `One or more listings are not available for your organization to route: ${notAvailable.join(', ')}`);
    }

    const owned = uniqueIds.map((id) => byId.get(id));

    const collected = owned.filter((row) => row.status === LISTING_STATUS.COLLECTED);
    if (collected.length > 0) {
        throw new AppError(409, `Listing(s) already collected and cannot be added to a route: ${collected.map((r) => r.id).join(', ')}`);
    }
    const expired = owned.filter((row) => row.status === LISTING_STATUS.EXPIRED);
    if (expired.length > 0) {
        throw new AppError(409, `Listing(s) expired and cannot be added to a route: ${expired.map((r) => r.id).join(', ')}`);
    }

    // A listing without its kitchen's coordinates cannot be geographically sequenced. Rather than fail the
    // whole request, it is excluded and reported - kept visible via a warning, never silently dropped.
    const warnings = [];
    const withCoordinates = [];
    owned.forEach((row) => {
        if (row.kitchen_latitude == null || row.kitchen_longitude == null) {
            warnings.push({ listingId: row.id, message: `Listing ${row.id} has no kitchen location on file and was excluded from the route.` });
            return;
        }
        withCoordinates.push(row);
    });

    // Reuses the existing rescue-priority scorer (ai/rescuePriority.js) as-is rather than re-deriving urgency -
    // "rescue priority if already available" per Task 18. It is purely informational context on each stop; the
    // planner's own sequencing rule is independent of it.
    const prioritized = rescuePriority.calculatePriorities(
        withCoordinates.map((row) => ({ id: row.id, quantity: row.quantity, safe_until_time: row.safe_until_time }))
    );
    const priorityById = new Map(prioritized.map((p) => [p.id, p.priorityScore]));

    const stops = withCoordinates.map((row) => ({
        listingId: row.id,
        latitude: row.kitchen_latitude,
        longitude: row.kitchen_longitude,
        safeUntilTime: row.safe_until_time,
        quantity: row.quantity,
        priorityScore: priorityById.get(row.id) ?? null,
    }));

    const origin =
        ngoOrg.latitude != null && ngoOrg.longitude != null
            ? { type: 'NGO', latitude: ngoOrg.latitude, longitude: ngoOrg.longitude }
            : { type: 'FIRST_STOP' };

    const planned = rescueRoutePlanner.planRoute({
        origin,
        stops,
        routeStartTime: new Date(),
        config: buildPlannerConfig(),
    });

    return {
        routeId: crypto.randomUUID(),
        ...planned,
        warnings: [...warnings, ...planned.warnings],
    };
}

module.exports = { previewRoute };
