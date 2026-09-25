const pool = require('../models/db');
const { buildForecast, normalizeTargetDate } = require('./forecastEngine');

const HISTORY_ROW_LIMIT = 120;
const EVENT_LOOKBACK_DAYS = 365; // measured back from the item's latest log before the target, not from the target itself

/**
 * Predict demand for a given menu item and target date.
 *
 * Context-aware statistical forecast (see forecastEngine.js): recency-weighted level, weekday
 * pattern, significance-gated trend and an attendance signal. It is NOT machine learning.
 * Falls back to the deterministic heuristic (average prepared quantity) with fewer than 3 days of
 * history. Only logs dated strictly before targetDate are read.
 *
 * @param {number} menuItemId
 * @param {string} targetDate (YYYY-MM-DD)
 * @param {boolean} isSimulation (default false) skips saving to db if true
 * @param {Object} [options] { expectedHeadcount } optional known attendance for targetDate
 * @returns {Object} { predictedQuantity, confidenceScore, modelVersion, keyFactors }
 *   predictedQuantity includes the 5% safety buffer; the approximate 80% demand range (before that buffer) is
 *   keyFactors.expected_range (absent for the fallback forecast).
 */
async function predictDemand(menuItemId, targetDate, isSimulation = false, options = {}) {
    const target = normalizeTargetDate(targetDate);
    if (!target) {
        throw new Error('Invalid targetDate: expected a real calendar date in YYYY-MM-DD format');
    }

    // 1. Fetch history strictly before the target date (leakage guard), plus the calendar events of the SAME
    //    organization as the menu item (derived server-side from the item, never from the client). The engine
    //    itself ignores events dated after the target date or entered after it.
    const [{ rows: logs }, { rows: events }] = await Promise.all([
        pool.query(
            `SELECT id, log_date, meal_slot, quantity_planned, quantity_prepared, quantity_leftover,
                    quantity_consumed, headcount,
                    (quantity_prepared - COALESCE(quantity_leftover, 0)) AS consumed
             FROM daily_logs
             WHERE menu_item_id = $1 AND log_date < $2::date
             ORDER BY log_date DESC, id DESC
             LIMIT $3`,
            [menuItemId, target, HISTORY_ROW_LIMIT]
        ),
        pool.query(
            `SELECT e.event_date, e.event_type, e.name, e.expected_impact_pct, e.created_at
             FROM organization_events e
             JOIN menu_items mi ON mi.kitchen_org_id = e.organization_id
             WHERE mi.id = $1 AND e.event_date <= $2::date
               AND e.event_date >= COALESCE(
                   (SELECT MAX(log_date) FROM daily_logs WHERE menu_item_id = $1 AND log_date < $2::date),
                   $2::date
               ) - $3::int
             ORDER BY e.event_date ASC, e.id ASC`,
            [menuItemId, target, EVENT_LOOKBACK_DAYS]
        ),
    ]);

    // 2. Forecast (pure, deterministic)
    const finalResult = buildForecast(logs, target, { ...options, events });

    // 3. Store prediction
    if (!isSimulation) {
        try {
            await pool.query(
                `INSERT INTO ai_forecasts
                 (menu_item_id, target_date, predicted_quantity, confidence_score, model_version, key_factors)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [menuItemId, target, finalResult.predictedQuantity, finalResult.confidenceScore, finalResult.modelVersion, finalResult.keyFactors]
            );
        } catch (e) {
            console.error("Failed to store forecast in DB", e);
            // We still return the prediction even if storage fails
        }
    }

    return finalResult;
}

module.exports = {
    predictDemand
};
