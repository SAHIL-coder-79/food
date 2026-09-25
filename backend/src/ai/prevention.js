const pool = require('../models/db');
const { predictDemand } = require('./forecasting');
const { CONFIDENCE_TYPE, expectedRangeOf } = require('./forecastEngine');

// Where the planned quantity sits against the forecast's expected demand range (null when there is no range).
// Informational only: it never changes the risk level, which is still based on predictedQuantity.
function positionInRange(plannedQuantity, range) {
    if (!range || !Number.isFinite(plannedQuantity)) return null;
    if (plannedQuantity > range.high) return 'above_range';
    if (plannedQuantity < range.low) return 'below_range';
    return 'within_range';
}

/**
 * Generate a prevention recommendation by comparing planned vs predicted demand.
 */
async function generatePreventionRecommendation(menuItemId, targetDate, plannedQuantity, kitchenOrgId) {
    // 1. Get forecast
    const forecastResult = await predictDemand(menuItemId, targetDate);
    const predictedQuantity = forecastResult.predictedQuantity;
    const expectedRange = expectedRangeOf(forecastResult);

    // 2. Compare
    const excess = plannedQuantity - predictedQuantity;
    let excessPercentage = 0;
    if (predictedQuantity > 0) {
        excessPercentage = (excess / predictedQuantity) * 100;
    } else if (excess > 0) {
        excessPercentage = Infinity;
    }

    // 3. Determine Risk
    let riskLevel = 'LOW';
    if (excessPercentage > 15) {
        riskLevel = 'HIGH';
    } else if (excessPercentage > 5) {
        riskLevel = 'MEDIUM';
    }

    // 4. Fetch historical effectiveness for this item
    const { rows: history } = await pool.query(
        `SELECT AVG(i.effectiveness_score) as avg_score, COUNT(*) as count 
         FROM ai_interventions i
         JOIN ai_prevention_recommendations r ON i.recommendation_id = r.id
         WHERE r.menu_item_id = $1 AND r.kitchen_org_id = $2`,
        [menuItemId, kitchenOrgId]
    );

    let historicalText = '';
    if (history.length > 0 && history[0].count > 0) {
        const avgScore = parseFloat(history[0].avg_score);
        if (avgScore > 0.5) {
            forecastResult.confidenceScore = Math.min(0.99, forecastResult.confidenceScore + 0.1);
            historicalText = ' Past reductions were highly effective.';
        } else if (avgScore < 0) {
            forecastResult.confidenceScore = Math.max(0.1, forecastResult.confidenceScore - 0.1);
            historicalText = ' Note: Past recommendations were rejected or inaccurate.';
        }
    }

    const result = {
        predictedQuantity,
        plannedQuantity,
        excess: Math.max(0, excess),
        riskLevel,
        recommendedQuantity: predictedQuantity,
        expectedRange,
        plannedVsExpectedRange: positionInRange(plannedQuantity, expectedRange),
        confidence: forecastResult.confidenceScore,
        confidenceType: CONFIDENCE_TYPE,
        evidence: forecastResult.keyFactors
    };

    // 5. If MEDIUM or HIGH, store a pending recommendation
    if (riskLevel === 'MEDIUM' || riskLevel === 'HIGH') {
        const text = `High risk of overproduction. Recommend reducing preparation by ${Math.round(excess)} units to match historical demand patterns.${historicalText}`;

        try {
            const insertResult = await pool.query(
                `INSERT INTO ai_prevention_recommendations
                 (kitchen_org_id, menu_item_id, target_date, recommendation_text, potential_savings, status, risk_level, recommended_quantity, estimated_excess, supporting_evidence)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING id`,
                [
                    kitchenOrgId,
                    menuItemId,
                    targetDate,
                    text,
                    0, // Financial savings can be calculated later
                    'pending',
                    riskLevel,
                    predictedQuantity,
                    excess,
                    result.evidence
                ]
            );
            // Exposed so callers (e.g. the frontend) can act on this specific
            // recommendation via PATCH /api/prevention/:id/status.
            result.recommendationId = insertResult?.rows?.[0]?.id ?? null;
        } catch (e) {
            console.error('Failed to store prevention recommendation:', e);
        }
    }

    return result;
}

/**
 * Update the status of an existing recommendation.
 */
async function updateRecommendationStatus(recommendationId, newStatus, kitchenOrgId) {
    if (!['approved', 'rejected'].includes(newStatus)) {
        throw new Error('Invalid status');
    }

    const { rowCount } = await pool.query(
        `UPDATE ai_prevention_recommendations 
         SET status = $1 
         WHERE id = $2 AND kitchen_org_id = $3`,
        [newStatus, recommendationId, kitchenOrgId]
    );

    if (rowCount === 0) {
        throw new Error('Recommendation not found or unauthorized');
    }

    return { status: newStatus };
}

module.exports = {
    generatePreventionRecommendation,
    updateRecommendationStatus
};
