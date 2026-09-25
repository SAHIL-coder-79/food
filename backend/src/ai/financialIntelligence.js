const pool = require('../models/db');

// Same estimate factors already used elsewhere in the AI layer (ai/simulator.js's
// what-if scenarios, ai/rescuePriority.js's meal-equivalent impact score) - reused
// here, not a new formula, so the live report and the simulator agree.
const CO2E_KG_PER_UNIT = 2.5; // kg CO2e per kg (unit) of food wasted
const MEAL_EQUIVALENT_KG = 0.4; // kg of food per meal-equivalent

/**
 * Calculates estimated financial loss from wasted food for a given period.
 * Uses cost_per_unit and preparation_cost_per_unit from menu_items.
 *
 * @param {number} kitchenOrgId - ID of the kitchen organization
 * @param {string} period - 'daily', 'weekly', 'monthly'
 * @returns {Object} Financial impact summary
 */
async function calculateFinancialImpact(kitchenOrgId, period) {
    // Determine date range based on period
    let interval = '1 day';
    if (period === 'weekly') interval = '7 days';
    if (period === 'monthly') interval = '1 month';

    // Query daily_logs joined with menu_items to calculate costs
    // Using quantity_leftover as the primary metric for wasted food (since it didn't get consumed as planned)
    const query = `
        SELECT 
            dl.log_date,
            mi.name AS menu_item_name,
            dl.quantity_leftover,
            COALESCE(mi.cost_per_unit, 0) AS cost_per_unit,
            COALESCE(mi.preparation_cost_per_unit, 0) AS preparation_cost_per_unit
        FROM daily_logs dl
        JOIN menu_items mi ON dl.menu_item_id = mi.id
        WHERE mi.kitchen_org_id = $1
          AND dl.log_date >= CURRENT_DATE - INTERVAL '${interval}'
          AND dl.quantity_leftover > 0
        ORDER BY dl.log_date DESC
    `;

    // Food this kitchen actually handed over to NGOs in the same period (the redistribution half of the loop).
    // Scoped through the listing's own kitchen; nothing here changes the loss figures below.
    const rescuedQuery = `
        SELECT COALESCE(SUM(t.quantity_collected), 0) AS collected_quantity, COUNT(*) AS listings_collected
        FROM transactions_log t
        JOIN surplus_listings sl ON sl.id = t.surplus_listing_id
        WHERE sl.kitchen_org_id = $1
          AND t.collected_at >= CURRENT_DATE - INTERVAL '${interval}'
    `;

    const [{ rows: logs }, { rows: rescuedRows }] = await Promise.all([
        pool.query(query, [kitchenOrgId]),
        pool.query(rescuedQuery, [kitchenOrgId]),
    ]);

    let totalEstimatedLoss = 0;
    let totalLeftoverQuantity = 0;
    const lossByDate = {};
    const lossByItem = {};

    logs.forEach(log => {
        const itemLoss = log.quantity_leftover * (log.cost_per_unit + log.preparation_cost_per_unit);
        totalEstimatedLoss += itemLoss;
        totalLeftoverQuantity += log.quantity_leftover;

        const dateStr = log.log_date instanceof Date ? log.log_date.toISOString().split('T')[0] : log.log_date;

        if (!lossByDate[dateStr]) lossByDate[dateStr] = 0;
        lossByDate[dateStr] += itemLoss;

        if (!lossByItem[log.menu_item_name]) lossByItem[log.menu_item_name] = 0;
        lossByItem[log.menu_item_name] += itemLoss;
    });

    // Format output
    const breakdown = {
        period,
        lossByDate,
        lossByItem,
        potentialSavings: totalEstimatedLoss // A 100% reduction in waste would save this amount
    };

    const estimatedCo2eKg = Math.round(totalLeftoverQuantity * CO2E_KG_PER_UNIT * 10) / 10;
    const mealEquivalents = Math.floor(totalLeftoverQuantity / MEAL_EQUIVALENT_KG);

    const rescuedQuantity = Number((rescuedRows && rescuedRows[0] && rescuedRows[0].collected_quantity) || 0);
    const rescued = {
        listingsCollected: Number((rescuedRows && rescuedRows[0] && rescuedRows[0].listings_collected) || 0),
        collectedQuantity: Math.round(rescuedQuantity * 100) / 100,
        mealEquivalents: Math.floor(rescuedQuantity / MEAL_EQUIVALENT_KG),
        co2eAvoidedKg: Math.round(rescuedQuantity * CO2E_KG_PER_UNIT * 10) / 10,
        isEstimate: true,
        note: 'Surplus handed over to NGOs in this period. It is still included in the loss above, which counts all leftover food recorded in the daily logs.',
    };

    const finalResult = {
        totalEstimatedLoss: Math.round(totalEstimatedLoss * 100) / 100,
        breakdown,
        environmentalImpact: {
            estimatedCo2eKg,
            mealEquivalents,
            isEstimate: true,
        },
        rescued,
        isEstimate: true
    };

    // Optionally persist summary logic for period=monthly or weekly end, but for simplicity, we insert the query snapshot.
    // We only insert if we actually found data to track
    if (logs.length > 0) {
        try {
            await pool.query(
                `INSERT INTO ai_financial_impacts
                 (organization_id, estimated_loss, estimated_co2e_avoided, breakdown)
                 VALUES ($1, $2, $3, $4)`,
                [kitchenOrgId, finalResult.totalEstimatedLoss, estimatedCo2eKg, finalResult.breakdown]
            );
        } catch (e) {
            console.error("Failed to store financial impact in DB", e);
        }
    }

    return finalResult;
}

module.exports = {
    calculateFinancialImpact
};
