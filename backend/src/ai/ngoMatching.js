const pool = require('../models/db');
const { haversineDistanceKm } = require('../utils/distance');
const { isWithinServiceRadius } = require('../utils/serviceRadius');
const { ORG_TYPES, VERIFICATION_STATUS, LISTING_STATUS } = require('../utils/constants');

// Distance (km)
const CLOSE_DISTANCE_KM = 3; // at/under this, distance score is maxed out
const MAX_MATCH_DISTANCE_KM = 25; // at/beyond this, distance score bottoms out

// Capacity/quantity fit
const DEFAULT_CAPACITY_KG = 20; // assumed when an NGO hasn't configured a capacity
const CAPACITY_GOOD_FIT_MAX_RATIO = 3; // capacity up to 3x quantity is a "good fit"
const CAPACITY_OVERSIZED_PENALTY_PER_RATIO = 5; // gentle penalty per ratio point beyond that
const CAPACITY_OVERSIZED_FLOOR = 70;

// Reliability (derived only from stored surplus_listings history, never invented)
const MIN_HISTORY_FOR_RELIABILITY = 3; // fewer completed pickups -> neutral default
const RELIABILITY_VOLUME_CAP = 20; // completed pickups at/above this cap the volume component
const FAST_RESPONSE_MINUTES = 30;
const SLOW_RESPONSE_MINUTES = 360;

// Urgency (time remaining until safe_until_time)
const MAX_URGENCY_MINUTES = 12 * 60;
const CRITICAL_URGENCY_MINUTES = 120;

const NEUTRAL_SCORE = 50; // used whenever a signal's underlying data is missing

const WEIGHTS = {
    distance: 0.25,
    capacity: 0.2,
    category: 0.15,
    reliability: 0.2,
    urgency: 0.2,
};

const MATCH_LEVEL_THRESHOLDS = { EXCELLENT: 80, GOOD: 60, FAIR: 40 };

function round1(value) {
    return Math.round(value * 10) / 10;
}

function levelFor(score) {
    if (score >= MATCH_LEVEL_THRESHOLDS.EXCELLENT) return 'EXCELLENT';
    if (score >= MATCH_LEVEL_THRESHOLDS.GOOD) return 'GOOD';
    if (score >= MATCH_LEVEL_THRESHOLDS.FAIR) return 'FAIR';
    return 'POOR';
}

function computeDistanceScore(distanceKm) {
    if (distanceKm === null || distanceKm === undefined) {
        return { score: NEUTRAL_SCORE, reason: 'Distance unknown (missing coordinates)' };
    }
    if (distanceKm <= CLOSE_DISTANCE_KM) {
        return { score: 100, reason: `Very close (${round1(distanceKm)} km away)` };
    }
    if (distanceKm >= MAX_MATCH_DISTANCE_KM) {
        return { score: 0, reason: `Far away (${round1(distanceKm)} km)` };
    }
    const score = 100 - ((distanceKm - CLOSE_DISTANCE_KM) / (MAX_MATCH_DISTANCE_KM - CLOSE_DISTANCE_KM)) * 100;
    return { score, reason: `${round1(distanceKm)} km away` };
}

function computeCapacityScore(capacityKg, quantity) {
    if (!quantity || quantity <= 0) {
        return { score: 0, reason: 'Listing has no quantity to match' };
    }
    const effectiveCapacity = capacityKg || DEFAULT_CAPACITY_KG;
    const ratio = effectiveCapacity / quantity;

    let score;
    if (ratio < 1) {
        score = Math.max(0, ratio * 100);
    } else if (ratio <= CAPACITY_GOOD_FIT_MAX_RATIO) {
        score = 100;
    } else {
        score = Math.max(CAPACITY_OVERSIZED_FLOOR, 100 - (ratio - CAPACITY_GOOD_FIT_MAX_RATIO) * CAPACITY_OVERSIZED_PENALTY_PER_RATIO);
    }

    const reason = capacityKg
        ? `NGO capacity (${capacityKg} kg) vs listing quantity (${quantity} kg)`
        : `NGO capacity not configured; assumed default (${DEFAULT_CAPACITY_KG} kg)`;
    return { score, reason };
}

function computeCategoryScore(foodType, preferredFoodTypes) {
    if (!preferredFoodTypes || preferredFoodTypes.length === 0) {
        return { score: 100, reason: 'NGO accepts all food categories' };
    }
    if (!foodType) {
        return { score: NEUTRAL_SCORE, reason: 'Listing has no food category to compare' };
    }
    const normalized = foodType.trim().toLowerCase();
    const isMatch = preferredFoodTypes.some((type) => type.trim().toLowerCase() === normalized);
    return isMatch
        ? { score: 100, reason: `Matches NGO's preferred category (${foodType})` }
        : { score: 30, reason: "Outside NGO's usual preferred categories" };
}

function computeReliabilityScore(completedPickups, avgResponseMinutes) {
    if (completedPickups < MIN_HISTORY_FOR_RELIABILITY) {
        return { score: NEUTRAL_SCORE, reason: 'Limited pickup history; using neutral default' };
    }

    const volumeScore = Math.min(100, (completedPickups / RELIABILITY_VOLUME_CAP) * 100);

    let speedScore = NEUTRAL_SCORE;
    if (avgResponseMinutes !== null && avgResponseMinutes !== undefined) {
        if (avgResponseMinutes <= FAST_RESPONSE_MINUTES) {
            speedScore = 100;
        } else if (avgResponseMinutes >= SLOW_RESPONSE_MINUTES) {
            speedScore = 0;
        } else {
            speedScore =
                100 - ((avgResponseMinutes - FAST_RESPONSE_MINUTES) / (SLOW_RESPONSE_MINUTES - FAST_RESPONSE_MINUTES)) * 100;
        }
    }

    const score = volumeScore * 0.5 + speedScore * 0.5;
    const responseText = avgResponseMinutes !== null && avgResponseMinutes !== undefined
        ? `~${Math.round(avgResponseMinutes)} min`
        : 'unknown';
    return { score, reason: `${completedPickups} completed pickups, avg response ${responseText}` };
}

function computeUrgencyScore(timeRemainingMins) {
    if (timeRemainingMins === null || timeRemainingMins === undefined) {
        return { score: NEUTRAL_SCORE, reason: 'Listing has no expiry set; urgency unknown' };
    }
    if (timeRemainingMins <= CRITICAL_URGENCY_MINUTES) {
        return { score: 100, reason: 'Expires within 2 hours - urgent pickup needed' };
    }
    if (timeRemainingMins >= MAX_URGENCY_MINUTES) {
        return { score: 0, reason: 'Plenty of time remaining before expiry' };
    }
    const score = 100 - ((timeRemainingMins - CRITICAL_URGENCY_MINUTES) / (MAX_URGENCY_MINUTES - CRITICAL_URGENCY_MINUTES)) * 100;
    return { score, reason: `${Math.round(timeRemainingMins)} minutes remaining before expiry` };
}

/**
 * Scores and ranks a set of candidate NGOs for a single surplus listing.
 * Pure/sync so it can be unit-tested with fixture data, no DB required.
 * @param {Object} listing { quantity, food_type, safe_until_time }
 * @param {Array} ngoCandidates NGO org rows merged with distance_km, completed_pickups, avg_response_minutes
 * @returns {Array} Ranked matches, highest matchScore first. Empty if the listing has expired.
 */
function scoreNgoMatches(listing, ngoCandidates) {
    const now = new Date();
    const quantity = listing.quantity || 0;
    const foodType = listing.food_type || null;

    const timeRemainingMins = listing.safe_until_time
        ? Math.max(0, (new Date(listing.safe_until_time) - now) / (1000 * 60))
        : null;

    // Never recommend expired food for rescue.
    if (timeRemainingMins === 0) {
        return [];
    }

    const urgency = computeUrgencyScore(timeRemainingMins);

    return ngoCandidates
        .map((ngo) => {
            const distance = computeDistanceScore(ngo.distance_km);
            const capacity = computeCapacityScore(ngo.capacity_kg, quantity);
            const category = computeCategoryScore(foodType, ngo.preferred_food_types);
            const reliability = computeReliabilityScore(ngo.completed_pickups || 0, ngo.avg_response_minutes);

            const matchScore =
                distance.score * WEIGHTS.distance +
                capacity.score * WEIGHTS.capacity +
                category.score * WEIGHTS.category +
                reliability.score * WEIGHTS.reliability +
                urgency.score * WEIGHTS.urgency;

            const reason = [distance.reason, capacity.reason, category.reason, reliability.reason, urgency.reason]
                .filter(Boolean)
                .join('; ');

            return {
                ngoOrgId: ngo.id,
                ngoName: ngo.name || null,
                matchScore: round1(matchScore),
                matchLevel: levelFor(matchScore),
                distanceKm: ngo.distance_km === null || ngo.distance_km === undefined ? null : round1(ngo.distance_km),
                reason,
                supportingMetrics: {
                    distance_score: round1(distance.score),
                    capacity_score: round1(capacity.score),
                    category_score: round1(category.score),
                    reliability_score: round1(reliability.score),
                    urgency_score: round1(urgency.score),
                    completed_pickups: ngo.completed_pickups || 0,
                    avg_response_minutes:
                        ngo.avg_response_minutes !== null && ngo.avg_response_minutes !== undefined
                            ? round1(ngo.avg_response_minutes)
                            : null,
                    quantity,
                    food_type: foodType,
                },
                matchMethod: 'scored',
            };
        })
        .sort((a, b) => b.matchScore - a.matchScore);
}

// Radius-only ordering, used when smart scoring can't be computed. This is the
// same rule surplusListingService already applies for the plain NGO feed.
function radiusFallback(candidates) {
    return candidates
        .slice()
        .sort((a, b) => {
            if (a.distance_km === null) return 1;
            if (b.distance_km === null) return -1;
            return a.distance_km - b.distance_km;
        })
        .map((ngo) => ({
            ngoOrgId: ngo.id,
            ngoName: ngo.name || null,
            matchScore: null,
            matchLevel: 'UNSCORED',
            distanceKm: ngo.distance_km === null ? null : round1(ngo.distance_km),
            reason: 'Smart scoring unavailable; ordered by distance only (radius fallback)',
            supportingMetrics: { distance_km: ngo.distance_km },
            matchMethod: 'radius_fallback',
        }));
}

async function fetchReliabilityStats(ngoOrgIds) {
    if (ngoOrgIds.length === 0) return {};
    const { rows } = await pool.query(
        `SELECT claimed_by_ngo_id AS ngo_org_id,
                COUNT(*) FILTER (WHERE status = $2) AS completed_pickups,
                AVG(EXTRACT(EPOCH FROM (claimed_at - created_at)) / 60) FILTER (WHERE claimed_at IS NOT NULL) AS avg_response_minutes
         FROM surplus_listings
         WHERE claimed_by_ngo_id = ANY($1::int[])
         GROUP BY claimed_by_ngo_id`,
        [ngoOrgIds, LISTING_STATUS.COLLECTED]
    );

    const statsByOrgId = {};
    for (const row of rows) {
        statsByOrgId[row.ngo_org_id] = {
            completedPickups: parseInt(row.completed_pickups, 10) || 0,
            avgResponseMinutes: row.avg_response_minutes !== null ? parseFloat(row.avg_response_minutes) : null,
        };
    }
    return statsByOrgId;
}

async function persistMatchScores(surplusListingId, ranked) {
    for (const match of ranked) {
        try {
            await pool.query(
                `INSERT INTO ai_ngo_match_scores
                 (surplus_listing_id, ngo_org_id, match_score, distance_km, match_level, reasoning, supporting_metrics)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [surplusListingId, match.ngoOrgId, match.matchScore, match.distanceKm, match.matchLevel, match.reason, match.supportingMetrics]
            );
        } catch (e) {
            // Best-effort tracking only; never block the response.
        }
    }
}

/**
 * Fetches verified NGOs in range of the listing's kitchen and returns them
 * ranked by rescue-match score. Falls back to plain radius/distance ordering
 * if smart scoring can't be computed (e.g. a transient DB error).
 * @param {Object} listing surplus_listings row
 * @param {Object} kitchenOrg organizations row for the listing's kitchen
 */
async function getRankedMatches(listing, kitchenOrg) {
    const { rows: ngoRows } = await pool.query(
        `SELECT id, name, latitude, longitude, service_radius_km, capacity_kg, preferred_food_types
         FROM organizations
         WHERE type = $1 AND verification_status = $2`,
        [ORG_TYPES.NGO, VERIFICATION_STATUS.VERIFIED]
    );

    const inRange = ngoRows.filter((ngo) => isWithinServiceRadius(kitchenOrg, ngo));
    if (inRange.length === 0) return [];

    const candidatesWithDistance = inRange.map((ngo) => ({
        ...ngo,
        distance_km: haversineDistanceKm(kitchenOrg.latitude, kitchenOrg.longitude, ngo.latitude, ngo.longitude),
    }));

    try {
        const statsByOrgId = await fetchReliabilityStats(candidatesWithDistance.map((ngo) => ngo.id));
        const merged = candidatesWithDistance.map((ngo) => ({
            ...ngo,
            completed_pickups: statsByOrgId[ngo.id]?.completedPickups || 0,
            avg_response_minutes: statsByOrgId[ngo.id]?.avgResponseMinutes ?? null,
        }));

        const ranked = scoreNgoMatches(listing, merged);
        await persistMatchScores(listing.id, ranked);
        return ranked;
    } catch (error) {
        console.error('NGO match scoring failed, falling back to radius/distance ordering:', error);
        return radiusFallback(candidatesWithDistance);
    }
}

module.exports = {
    scoreNgoMatches,
    getRankedMatches,
};
