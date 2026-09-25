const pool = require('../models/db');
const { isWithinServiceRadius } = require('../utils/serviceRadius');

// Constants for scoring
const MAX_URGENCY_MINUTES = 12 * 60; // 12 hours
const MEAL_EQUIVALENT_KG = 0.4;
const URGENCY_WEIGHT = 0.6;
const IMPACT_WEIGHT = 0.4;

/**
 * Calculates priority scores for active surplus listings.
 * @param {Array} listings Array of surplus_listings records
 * @returns {Array} Array of prioritized listings
 */
function calculatePriorities(listings) {
    const now = new Date();

    return listings.map(listing => {
        // Handle null/missing safe_until
        if (!listing.safe_until_time) {
            return {
                ...listing,
                priorityScore: 0,
                priorityLevel: 'LOW',
                urgencyScore: 0,
                impactScore: 0,
                reason: 'Missing safe until time',
                supportingMetrics: { time_remaining_mins: 0, meals: 0 }
            };
        }

        const safeUntil = new Date(listing.safe_until_time);
        const timeRemainingMins = Math.max(0, (safeUntil - now) / (1000 * 60));

        // 1. Urgency Score (0-100)
        let urgencyScore = 0;
        if (timeRemainingMins === 0) {
            urgencyScore = 0; // Expired
        } else if (timeRemainingMins <= 120) {
            urgencyScore = 100; // < 2 hours is max urgency
        } else if (timeRemainingMins < MAX_URGENCY_MINUTES) {
            // Scale linearly from 100 to 0 between 2 hours and 12 hours
            urgencyScore = 100 - ((timeRemainingMins - 120) / (MAX_URGENCY_MINUTES - 120) * 100);
        }

        // 2. Impact Score (0-100)
        let quantity = listing.quantity;
        if (typeof quantity !== 'number' || quantity <= 0) {
            quantity = 0;
        }
        const mealEquivalents = quantity / MEAL_EQUIVALENT_KG;
        
        // Let's cap impact at 100 meals for scoring purposes (100 meals = score 100)
        let impactScore = Math.min(100, mealEquivalents);

        // 3. Total Priority Score
        let priorityScore = (urgencyScore * URGENCY_WEIGHT) + (impactScore * IMPACT_WEIGHT);

        // If expired, zero everything out
        if (timeRemainingMins === 0) {
            priorityScore = 0;
            impactScore = 0;
        }

        // 4. Priority Level
        let priorityLevel = 'LOW';
        if (timeRemainingMins === 0) {
            priorityLevel = 'LOW';
        } else if (priorityScore >= 80 || (timeRemainingMins > 0 && timeRemainingMins <= 120)) {
            priorityLevel = 'CRITICAL';
        } else if (priorityScore >= 60) {
            priorityLevel = 'HIGH';
        } else if (priorityScore >= 40) {
            priorityLevel = 'MEDIUM';
        }

        return {
            ...listing,
            priorityScore: Math.round(priorityScore * 10) / 10,
            priorityLevel,
            urgencyScore: Math.round(urgencyScore * 10) / 10,
            impactScore: Math.round(impactScore * 10) / 10,
            reason: timeRemainingMins === 0 ? 'Expired' : `Score based on ${Math.round(timeRemainingMins)} mins remaining and ${Math.round(mealEquivalents)} meals`,
            supportingMetrics: {
                time_remaining_mins: Math.round(timeRemainingMins),
                meal_equivalents: Math.round(mealEquivalents * 10) / 10
            }
        };
    }).sort((a, b) => b.priorityScore - a.priorityScore);
}

/**
 * Fetch active listings and apply priority scoring.
 * When `ngoOrg` is given, only listings inside that NGO's own service area are returned (the same rule the surplus
 * feed applies, which fails open when coordinates or a radius are missing). The kitchen's coordinates are used for
 * that check only and are never part of the result.
 */
async function getPrioritizedListings(userOrganizationId = null, { ngoOrg = null } = {}) {
    // Basic filter: only Available listings
    const query = `
        SELECT sl.id, sl.quantity, sl.food_type, sl.prepared_time, sl.safe_until_time, sl.kitchen_org_id, sl.status,
               o.latitude AS kitchen_latitude, o.longitude AS kitchen_longitude
        FROM surplus_listings sl
        LEFT JOIN organizations o ON o.id = sl.kitchen_org_id
        WHERE sl.status = 'Available'
    `;

    const { rows: fetched } = await pool.query(query);
    const listings = fetched
        .filter((row) => !ngoOrg || isWithinServiceRadius({ latitude: row.kitchen_latitude, longitude: row.kitchen_longitude }, ngoOrg))
        .map(({ kitchen_latitude, kitchen_longitude, ...listing }) => listing);

    const prioritized = calculatePriorities(listings);

    // Optionally save to ai_rescue_priorities table here, or just return dynamically
    // Returning dynamically ensures real-time accuracy since urgency changes every minute.
    
    // We will save to DB to fulfill PRD requirement tracking
    for (const item of prioritized) {
        if (item.priorityScore > 0) {
            try {
                // Upsert logic or insert new tracking row
                await pool.query(
                    `INSERT INTO ai_rescue_priorities 
                     (surplus_listing_id, priority_score, priority_level, urgency_score, impact_score, reasoning, supporting_metrics)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [item.id, item.priorityScore, item.priorityLevel, item.urgencyScore, item.impactScore, item.reason, item.supportingMetrics]
                );
            } catch (e) {
                // Ignore unique/insert errors for tracking
            }
        }
    }

    // Filter out expired items from the final return
    return prioritized.filter(item => item.supportingMetrics.time_remaining_mins > 0);
}

module.exports = {
    calculatePriorities,
    getPrioritizedListings
};
