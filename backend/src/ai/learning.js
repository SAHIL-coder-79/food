const pool = require('../models/db');

/**
 * Evaluates the effectiveness of past prevention recommendations
 * by comparing them against the actual logged outcomes.
 * 
 * @param {number} kitchenOrgId - ID of the kitchen organization
 * @param {string} targetDate - Date to evaluate (YYYY-MM-DD)
 * @returns {Array} List of processed interventions
 */
async function evaluateInterventions(kitchenOrgId, targetDate) {
    // Find all recommendations for this date that are not in 'new' status
    const query = `
        SELECT r.id, r.menu_item_id, r.target_date, r.status AS manager_action, 
               r.recommended_quantity, r.estimated_excess,
               d.quantity_prepared, d.quantity_leftover
        FROM ai_prevention_recommendations r
        LEFT JOIN daily_logs d ON r.menu_item_id = d.menu_item_id AND r.target_date = d.log_date
        WHERE r.kitchen_org_id = $1 
          AND r.target_date = $2
          AND r.status IN ('approved', 'rejected')
    `;

    const { rows: recommendations } = await pool.query(query, [kitchenOrgId, targetDate]);

    const processedInterventions = [];

    for (const rec of recommendations) {
        if (!rec.quantity_prepared) continue; // No actual log exists yet, can't evaluate

        const originalPlannedQuantity = rec.recommended_quantity + rec.estimated_excess;
        
        let effectivenessScore = 0;
        let expectedResult = { recommended_quantity: rec.recommended_quantity, estimated_excess: rec.estimated_excess };
        let actualOutcome = { quantity_prepared: rec.quantity_prepared, quantity_leftover: rec.quantity_leftover };

        // If approved: did they actually prepare the recommended amount (or less)?
        // If they prepped what we recommended and waste was low, score goes up.
        // If they prepped what we recommended and waste was STILL high, our recommendation wasn't aggressive enough.
        
        // Base math: if they followed the recommendation, how much did they save compared to original plan?
        const amountAvoided = Math.max(0, originalPlannedQuantity - rec.quantity_prepared);
        
        if (rec.manager_action === 'approved') {
            if (rec.quantity_leftover === 0) {
                // Perfect intervention: reduced prep and zero waste
                effectivenessScore = 1.0;
            } else {
                // Still some waste, partial effectiveness
                // E.g., if they avoided 10 waste, but still wasted 5, score = 10 / (10 + 5) = 0.66
                const totalWasteRisk = amountAvoided + rec.quantity_leftover;
                effectivenessScore = totalWasteRisk > 0 ? (amountAvoided / totalWasteRisk) : 0;
            }
        } else if (rec.manager_action === 'rejected') {
            // If they rejected it, did they waste food?
            // If they wasted food, our recommendation was good, but they ignored it.
            // If they didn't waste food, our recommendation was bad.
            if (rec.quantity_leftover > 0) {
                effectivenessScore = 1.0; // The AI was right, but user rejected
            } else {
                effectivenessScore = -1.0; // The AI was wrong, user was right to reject
            }
        }

        // Store intervention
        try {
            await pool.query(
                `INSERT INTO ai_interventions 
                 (kitchen_org_id, intervention_type, recommendation_id, expected_result, actual_outcome, effectiveness_score, manager_action) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    kitchenOrgId, 
                    'prevention_evaluation', 
                    rec.id, 
                    JSON.stringify(expectedResult), 
                    JSON.stringify(actualOutcome), 
                    Math.round(effectivenessScore * 100) / 100,
                    rec.manager_action
                ]
            );

            processedInterventions.push({
                recommendationId: rec.id,
                effectivenessScore,
                managerAction: rec.manager_action
            });

        } catch (e) {
            console.error("Failed to store intervention", e);
        }
    }

    return processedInterventions;
}

module.exports = {
    evaluateInterventions
};
