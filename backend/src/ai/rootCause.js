const pool = require('../models/db');

/**
 * Analyzes the root cause of food waste for a specific daily log.
 * @param {number} dailyLogId 
 * @returns {Object} Root cause analysis result
 */
async function analyzeWasteRootCause(dailyLogId) {
    // 1. Fetch the target daily log
    const { rows: targetLogs } = await pool.query(
        `SELECT id, menu_item_id, log_date, meal_slot, quantity_planned, quantity_prepared, headcount, quantity_consumed, quantity_leftover 
         FROM daily_logs 
         WHERE id = $1`,
        [dailyLogId]
    );

    if (targetLogs.length === 0) {
        throw new Error('Daily log not found');
    }

    const targetLog = targetLogs[0];
    
    // Ensure we don't divide by zero and handle missing data gracefully
    const prepared = targetLog.quantity_prepared || 0;
    const leftover = targetLog.quantity_leftover || 0;
    const consumed = (targetLog.quantity_consumed !== undefined && targetLog.quantity_consumed !== null) ? targetLog.quantity_consumed : (prepared - leftover);
    const planned = targetLog.quantity_planned || prepared; // Default to prepared if no planned quantity
    const headcount = targetLog.headcount || 0;

    // Fast exit if no waste
    if (leftover <= 0) {
        return {
            cause: 'no_waste',
            affectedItem: targetLog.menu_item_id,
            supportingMetrics: { leftover: 0 },
            estimatedContribution: 0,
            confidenceScore: 1.0
        };
    }

    // 2. Fetch historical context (last 30 days for this menu item)
    const { rows: historyLogs } = await pool.query(
        `SELECT log_date, quantity_prepared, headcount, quantity_consumed, quantity_leftover
         FROM daily_logs 
         WHERE menu_item_id = $1 AND id != $2
         ORDER BY log_date DESC 
         LIMIT 30`,
        [targetLog.menu_item_id, dailyLogId]
    );

    if (historyLogs.length < 3) {
        return {
            cause: 'insufficient_data',
            affectedItem: targetLog.menu_item_id,
            supportingMetrics: { data_points: historyLogs.length },
            estimatedContribution: 0,
            confidenceScore: 0.0
        };
    }

    // 3. Calculate historical averages
    const avgHeadcount = historyLogs.reduce((sum, l) => sum + (l.headcount || 0), 0) / historyLogs.length;
    let totalConsumed = 0;
    let totalHeadcount = 0;
    
    historyLogs.forEach(l => {
        const c = (l.quantity_consumed !== undefined && l.quantity_consumed !== null) ? l.quantity_consumed : ((l.quantity_prepared || 0) - (l.quantity_leftover || 0));
        totalConsumed += Math.max(0, c);
        totalHeadcount += (l.headcount || 0);
    });
    
    const avgConsumptionPerPerson = totalHeadcount > 0 ? (totalConsumed / totalHeadcount) : 0;
    const currentConsumptionPerPerson = headcount > 0 ? (consumed / headcount) : 0;

    // 4. Fetch the AI forecast for this date (if any)
    const { rows: forecasts } = await pool.query(
        `SELECT predicted_quantity 
         FROM ai_forecasts 
         WHERE menu_item_id = $1 AND target_date = $2 
         ORDER BY created_at DESC LIMIT 1`,
        [targetLog.menu_item_id, targetLog.log_date]
    );
    const forecastedQuantity = forecasts.length > 0 ? forecasts[0].predicted_quantity : null;

    // 5. Evaluate Causes and Score them
    const causes = [];

    // Cause A: Over-preparation (ignoring forecast/plan)
    if (prepared > planned * 1.1) {
        causes.push({
            cause: 'over_preparation_vs_plan',
            score: 0.8,
            metrics: { prepared, planned, overage: prepared - planned },
            contribution: Math.min(leftover, prepared - planned)
        });
    }

    // Cause B: Forecast Overestimation
    if (forecastedQuantity && forecastedQuantity > (consumed * 1.2)) {
        causes.push({
            cause: 'forecast_overestimation',
            score: 0.75,
            metrics: { forecasted: forecastedQuantity, consumed, overage: forecastedQuantity - consumed },
            contribution: Math.min(leftover, forecastedQuantity - consumed)
        });
    }

    // Cause C: Low Attendance
    if (headcount > 0 && avgHeadcount > 0 && headcount < (avgHeadcount * 0.85)) {
        const expectedConsumption = headcount * avgConsumptionPerPerson;
        causes.push({
            cause: 'low_attendance',
            score: 0.85,
            metrics: { actual_headcount: headcount, avg_headcount: avgHeadcount },
            contribution: Math.min(leftover, Math.max(0, prepared - expectedConsumption))
        });
    }

    // Cause D: Low Consumption (Unpopular dish today)
    if (headcount > 0 && avgConsumptionPerPerson > 0 && currentConsumptionPerPerson < (avgConsumptionPerPerson * 0.8)) {
        const expectedConsumption = headcount * avgConsumptionPerPerson;
        causes.push({
            cause: 'low_consumption_rate',
            score: 0.8,
            metrics: { current_rate: currentConsumptionPerPerson, avg_rate: avgConsumptionPerPerson },
            contribution: Math.min(leftover, Math.max(0, expectedConsumption - consumed))
        });
    }

    // Determine highest scoring cause
    let finalCause = {
        cause: 'unexplained_variance',
        score: 0.3,
        metrics: { leftover, prepared, consumed },
        contribution: leftover
    };

    if (causes.length > 0) {
        finalCause = causes.reduce((prev, current) => (prev.score > current.score) ? prev : current);
    }

    const result = {
        cause: finalCause.cause,
        affectedItem: targetLog.menu_item_id,
        supportingMetrics: finalCause.metrics,
        estimatedContribution: Math.round(finalCause.contribution * 10) / 10,
        confidenceScore: finalCause.score
    };

    // Store in DB
    try {
        await pool.query(
            `INSERT INTO ai_waste_root_causes 
             (daily_log_id, inferred_cause, confidence_score, supporting_metrics, estimated_contribution) 
             VALUES ($1, $2, $3, $4, $5)`,
            [dailyLogId, result.cause, result.confidenceScore, result.supportingMetrics, result.estimatedContribution]
        );
    } catch (e) {
        console.error("Failed to store root cause in DB", e);
    }

    return result;
}

module.exports = {
    analyzeWasteRootCause
};
