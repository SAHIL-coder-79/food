const pool = require('../models/db');
const { predictDemand } = require('./forecasting');

/**
 * Runs a What-If simulation without modifying real records.
 * 
 * @param {number} kitchenOrgId - ID of the kitchen organization
 * @param {Object} scenario - { menuItemId, targetDate, proposedQuantity }
 * @returns {Object} Simulation result
 */
async function runSimulation(kitchenOrgId, scenario) {
    const { menuItemId, targetDate, proposedQuantity } = scenario;

    if (!menuItemId || !targetDate || proposedQuantity === undefined) {
        throw new Error('Missing required scenario parameters (menuItemId, targetDate, proposedQuantity)');
    }

    // 1. Fetch costs for the item to calculate financial impacts
    const { rows: items } = await pool.query(
        `SELECT COALESCE(cost_per_unit, 0) AS cost_per_unit, COALESCE(preparation_cost_per_unit, 0) AS preparation_cost_per_unit
         FROM menu_items 
         WHERE id = $1 AND kitchen_org_id = $2`,
        [menuItemId, kitchenOrgId]
    );

    if (items.length === 0) {
        throw new Error('Menu item not found or unauthorized');
    }

    const { cost_per_unit, preparation_cost_per_unit } = items[0];

    // 2. Fetch the demand forecast (passing isSimulation = true so it doesn't write to ai_forecasts)
    const forecast = await predictDemand(menuItemId, targetDate, true);
    const predictedDemand = forecast.predictedQuantity;

    // 3. Calculate impacts
    const estimatedSurplus = Math.max(0, proposedQuantity - predictedDemand);
    const estimatedShortageRisk = Math.max(0, predictedDemand - proposedQuantity);
    
    // Financial: money wasted on surplus
    const financialWaste = estimatedSurplus * (cost_per_unit + preparation_cost_per_unit);
    
    // Environmental: 2.5 kg CO2e per kg of food, 0.4 kg = 1 meal. 
    // Assuming proposedQuantity is in kg for this math, if it's units, it's roughly proportional.
    const co2eSaved = estimatedSurplus * 2.5; 
    const mealsSaved = Math.floor(estimatedSurplus / 0.4);

    const result = {
        proposedQuantity,
        predictedDemand,
        estimatedSurplus,
        estimatedShortageRisk,
        financialWaste: Math.round(financialWaste * 100) / 100,
        environmentalImpact: {
            co2eEmissionsKg: Math.round(co2eSaved * 10) / 10,
            mealEquivalents: mealsSaved
        },
        isEstimate: true
    };

    // 4. Log simulation to ai_simulations table (read-only for forecasting, but we log that a simulation occurred)
    try {
        await pool.query(
            `INSERT INTO ai_simulations 
             (kitchen_org_id, scenario_name, parameters, predicted_outcome) 
             VALUES ($1, $2, $3, $4)`,
            [
                kitchenOrgId, 
                'What-If Preparation Adjustment', 
                JSON.stringify(scenario), 
                JSON.stringify(result)
            ]
        );
    } catch (e) {
        console.error("Failed to store simulation log in DB", e);
    }

    return result;
}

module.exports = {
    runSimulation
};
