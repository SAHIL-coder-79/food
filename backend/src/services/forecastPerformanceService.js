'use strict';

const forecastPerformanceModel = require('../models/forecastPerformanceModel');
const menuItemModel = require('../models/menuItemModel');
const AppError = require('../utils/AppError');
const { buildForecast, FALLBACK_MODEL_VERSION } = require('../ai/forecastEngine');

// Closed loop: FORECAST -> ACTUAL DAILY LOG -> FORECAST ERROR -> LEARNING METRIC -> INTERVENTION EFFECTIVENESS.
//
// This layer only MEASURES. It never feeds errors back into the forecast (no bias correction), so it cannot
// change forecasts and cannot leak an outcome into an earlier prediction. Leakage rules:
//   - a stored forecast counts as a real ("stored") forecast only if it was created before the day's
//     outcome was first recorded; a forecast created afterwards is never treated as prospective;
//   - when no such forecast exists, the forecast is RECONSTRUCTED with the engine from logs dated strictly
//     before the target date (the same rows/limit the live endpoint reads) and labelled as reconstructed;
//   - improvement trends compare older vs newer target dates only; nothing is ever back-filled;
//   - a log entered AFTER the end of the target day was not knowable when that forecast would have been made.
//     By default (historyAsOf=log_date) reconstruction still uses every log DATED before the target, so bulk-loaded or
//     back-filled history can be evaluated, and reports how many reconstructed forecasts relied on such late-entered
//     logs. With historyAsOf=recorded_at it is strictly point-in-time: late-entered logs are left out, and a saved
//     forecast counts as prospective only if it was made before the end of its target day.

const DAY_MS = 86400000;
const DEFAULT_WINDOW_DAYS = 90;
const HISTORY_LOOKBACK_DAYS = 200;
const HISTORY_ROW_LIMIT = 120; // matches predictDemand's query
const EVENT_LOOKBACK_DAYS = 365; // matches predictDemand's events query
const MAX_RECORDS = 100;
const EXACT_TOLERANCE = 0.05; // forecasts are rounded to 1 decimal
const TREND_MIN_RECORDS = 6;
const TREND_CHANGE_POINTS = 2; // WAPE change (percentage points) needed to call a trend
const BIAS_NOTE_THRESHOLD_PCT = 10; // the forecast already includes a 5% safety buffer
const MIN_RECORDS_FOR_HARDEST_ITEM = 3;

const round = (value, decimals) => {
    const factor = 10 ** decimals;
    const r = Math.round(value * factor) / factor;
    return r === 0 ? 0 : r;
};
const r1 = (v) => round(v, 1);
const r2 = (v) => round(v, 2);

function toDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!match) return null;
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(ms) ? null : ms / DAY_MS;
}
const fromDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (day) => (((day + 4) % 7) + 7) % 7;
const weekStartOf = (day) => day - ((weekdayOf(day) + 6) % 7); // Monday

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toTime(value) {
    if (value === null || value === undefined) return NaN;
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const mean = (values) => values.slice().sort((a, b) => a - b).reduce((s, v) => s + v, 0) / values.length;

// Same definition of "actual demand" the forecast engine learns from.
function demandOf(row) {
    let value = toNumber(row.quantity_consumed);
    if (value === null) value = toNumber(row.consumed);
    if (value === null) {
        const prepared = toNumber(row.quantity_prepared);
        if (prepared !== null) value = prepared - (toNumber(row.quantity_leftover) ?? 0);
    }
    return value !== null && value >= 0 ? value : null;
}

function errorMetrics(predicted, actual) {
    const error = predicted - actual;
    const abs = Math.abs(error);
    return {
        raw: { predicted, actual, error, abs },
        view: {
            error: r2(error),
            absoluteError: r2(abs),
            percentageError: actual > 0 ? r1((error / actual) * 100) : null,
            absolutePercentageError: actual > 0 ? r1((abs / actual) * 100) : null,
            direction: abs < EXACT_TOLERANCE ? 'exact' : error > 0 ? 'over' : 'under',
        },
    };
}

function aggregate(evals) {
    const n = evals.length;
    if (n === 0) {
        return {
            evaluatedCount: 0, totalPredicted: 0, totalActual: 0, mae: null, mape: null, wape: null, bias: null,
            biasPercentage: null, accuracyPercentage: null, overpredictedCount: 0, underpredictedCount: 0, exactCount: 0, rangeHitRate: null,
        };
    }
    let predicted = 0;
    let actual = 0;
    let abs = 0;
    let signed = 0;
    let mapeSum = 0;
    let mapeCount = 0;
    let over = 0;
    let under = 0;
    let exact = 0;
    let rangeCount = 0;
    let rangeHits = 0;

    evals.forEach((e) => {
        predicted += e.raw.predicted;
        actual += e.raw.actual;
        abs += e.raw.abs;
        signed += e.raw.error;
        if (e.raw.actual > 0) {
            mapeSum += (e.raw.abs / e.raw.actual) * 100;
            mapeCount += 1;
        }
        if (e.view.direction === 'over') over += 1;
        else if (e.view.direction === 'under') under += 1;
        else exact += 1;
        if (e.range) {
            rangeCount += 1;
            if (e.raw.actual >= e.range.low && e.raw.actual <= e.range.high) rangeHits += 1;
        }
    });

    const wape = actual > 0 ? (abs / actual) * 100 : null;
    return {
        evaluatedCount: n,
        totalPredicted: r2(predicted),
        totalActual: r2(actual),
        mae: r2(abs / n),
        mape: mapeCount ? r1(mapeSum / mapeCount) : null,
        wape: wape === null ? null : r1(wape),
        bias: r2(signed / n),
        biasPercentage: actual > 0 ? r1((signed / actual) * 100) : null,
        accuracyPercentage: wape === null ? null : r1(Math.max(0, 100 - wape)),
        overpredictedCount: over,
        underpredictedCount: under,
        exactCount: exact,
        rangeHitRate: rangeCount ? r1((rangeHits / rangeCount) * 100) : null,
    };
}

const compact = (agg) => ({ evaluatedCount: agg.evaluatedCount, mae: agg.mae, wape: agg.wape, accuracyPercentage: agg.accuracyPercentage });

function wapeOf(evals) {
    const actual = evals.reduce((s, e) => s + e.raw.actual, 0);
    if (actual <= 0) return null;
    return (evals.reduce((s, e) => s + e.raw.abs, 0) / actual) * 100;
}

function computeTrend(sortedEvals) {
    const n = sortedEvals.length;
    if (n < TREND_MIN_RECORDS) {
        return { direction: 'insufficient_data', minimumRecords: TREND_MIN_RECORDS, evaluatedCount: n, olderWape: null, newerWape: null, changePoints: null };
    }
    const half = Math.floor(n / 2);
    const older = wapeOf(sortedEvals.slice(0, half));
    const newer = wapeOf(sortedEvals.slice(half));
    if (older === null || newer === null) {
        return { direction: 'insufficient_data', minimumRecords: TREND_MIN_RECORDS, evaluatedCount: n, olderWape: null, newerWape: null, changePoints: null };
    }
    const change = newer - older;
    let direction = 'stable';
    if (change <= -TREND_CHANGE_POINTS) direction = 'improving';
    else if (change >= TREND_CHANGE_POINTS) direction = 'worsening';
    return { direction, minimumRecords: TREND_MIN_RECORDS, evaluatedCount: n, olderWape: r1(older), newerWape: r1(newer), changePoints: r1(change) };
}

function summariseEffectiveness(items) {
    const scores = (list) => list.filter((i) => i.outcome.evaluated).map((i) => i.outcome.effectivenessScore);
    const avg = (list) => (list.length ? r2(list.reduce((s, v) => s + v, 0) / list.length) : null);
    const evaluatedScores = scores(items);
    const byAction = (action) => {
        const subset = items.filter((i) => i.managerAction === action);
        return { decidedCount: subset.length, evaluatedCount: scores(subset).length, averageEffectivenessScore: avg(scores(subset)) };
    };
    return {
        decidedCount: items.length,
        evaluatedCount: evaluatedScores.length,
        pendingEvaluationCount: items.filter((i) => !i.outcome.evaluated && i.actual).length,
        awaitingActualCount: items.filter((i) => !i.actual).length,
        averageEffectivenessScore: avg(evaluatedScores),
        positiveOutcomeShare: evaluatedScores.length ? r1((evaluatedScores.filter((s) => s > 0).length / evaluatedScores.length) * 100) : null,
        approved: byAction('approved'),
        rejected: byAction('rejected'),
    };
}

function buildInsights({ summary, trend, byMenuItem }) {
    const insights = [];
    if (summary.evaluatedCount === 0) {
        insights.push({
            type: 'no_evaluated_forecasts',
            message: 'No forecast has been compared with an actual daily log yet. Record daily logs for forecasted dates to start measuring accuracy.',
        });
    } else {
        if (summary.accuracyPercentage !== null) {
            insights.push({
                type: 'overall_accuracy',
                message: `Forecasts were about ${summary.accuracyPercentage}% accurate across ${summary.evaluatedCount} evaluated item-day(s) (average error ${summary.mae} per item-day).`,
            });
        }
        if (summary.biasPercentage !== null) {
            if (summary.biasPercentage >= BIAS_NOTE_THRESHOLD_PCT) {
                insights.push({ type: 'bias_over', message: `Forecasts tend to over-predict by about ${summary.biasPercentage}% (this includes the 5% safety buffer).` });
            } else if (summary.biasPercentage <= -BIAS_NOTE_THRESHOLD_PCT) {
                insights.push({ type: 'bias_under', message: `Forecasts tend to under-predict by about ${Math.abs(summary.biasPercentage)}%, which risks running short.` });
            } else {
                insights.push({ type: 'bias_balanced', message: `No strong over- or under-prediction (average bias ${summary.biasPercentage}%, including the 5% safety buffer).` });
            }
        }
        if (trend.direction === 'improving' || trend.direction === 'worsening') {
            insights.push({
                type: `trend_${trend.direction}`,
                message: `Forecast error is ${trend.direction === 'improving' ? 'improving' : 'getting worse'}: ${trend.olderWape}% earlier vs ${trend.newerWape}% in the most recent half.`,
            });
        } else if (trend.direction === 'stable') {
            insights.push({ type: 'trend_stable', message: `Forecast error is stable (${trend.olderWape}% earlier vs ${trend.newerWape}% recently).` });
        }
        const hardest = byMenuItem
            .filter((i) => i.evaluatedCount >= MIN_RECORDS_FOR_HARDEST_ITEM && i.wape !== null)
            .sort((a, b) => b.wape - a.wape || compareText(a.name, b.name) || a.menuItemId - b.menuItemId)[0];
        if (hardest && byMenuItem.length > 1) {
            insights.push({ type: 'hardest_item', message: `${hardest.name} is the hardest to forecast (${hardest.wape}% error over ${hardest.evaluatedCount} days).` });
        }
    }
    if (summary.missingActualCount > 0) {
        insights.push({
            type: 'missing_actuals',
            message: `${summary.missingActualCount} past forecast(s) have no actual daily log, so they could not be evaluated.`,
        });
    }
    return insights;
}

/**
 * Pure calculation. Inputs are plain rows (see forecastPerformanceModel) so it is fully unit-testable.
 * @param {Object} args
 * @param {Array} args.logs daily-log rows for the organization, including history before period.startDate
 * @param {Array} args.forecasts stored ai_forecasts rows (org-scoped)
 * @param {Array} args.recommendations approved/rejected prevention recommendations (+ latest outcome)
 * @param {{startDate:string,endDate:string}} args.period inclusive range of TARGET dates
 * @param {string} args.today local calendar date (YYYY-MM-DD), injected for reproducibility
 * @param {'all'|'stored'} [args.source]
 */
function computeForecastPerformance({ logs = [], forecasts = [], recommendations = [], events = [], period, today, source = 'all', historyAsOf = 'log_date' }) {
    const strictAsOf = historyAsOf === 'recorded_at';
    const startDay = toDay(period.startDate);
    const endDay = toDay(period.endDate);
    const todayDay = toDay(today);

    // ---- index logs ----
    const itemMeta = new Map();
    const logsByItem = new Map();
    const actualByKey = new Map();

    logs.forEach((row) => {
        const day = toDay(row.log_date);
        if (day === null) return;
        if (!itemMeta.has(row.menu_item_id)) itemMeta.set(row.menu_item_id, { name: row.menu_item_name, unit: row.menu_item_unit });
        if (!logsByItem.has(row.menu_item_id)) logsByItem.set(row.menu_item_id, []);
        logsByItem.get(row.menu_item_id).push({ row, day, recordedMs: toTime(row.created_at) });

        if (day < startDay || day > endDay) return;
        const demand = demandOf(row);
        if (demand === null) return;
        const key = `${row.menu_item_id}|${day}`;
        if (!actualByKey.has(key)) {
            actualByKey.set(key, { itemId: row.menu_item_id, day, demands: [], prepared: [], leftover: [], recordedAt: [], soldOut: false });
        }
        const entry = actualByKey.get(key);
        entry.demands.push(demand);
        const prepared = toNumber(row.quantity_prepared);
        const leftover = toNumber(row.quantity_leftover);
        if (prepared !== null) entry.prepared.push(prepared);
        if (leftover !== null) entry.leftover.push(leftover);
        if (prepared !== null && prepared > 0 && leftover === 0) entry.soldOut = true;
        const recordedAt = toTime(row.created_at);
        if (!Number.isNaN(recordedAt)) entry.recordedAt.push(recordedAt);
    });
    logsByItem.forEach((list) => list.sort((a, b) => a.day - b.day || a.row.id - b.row.id));

    const actualOf = (entry) => ({
        consumedQuantity: r2(mean(entry.demands)),
        preparedQuantity: entry.prepared.length ? r2(mean(entry.prepared)) : null,
        leftoverQuantity: entry.leftover.length ? r2(mean(entry.leftover)) : null,
        logCount: entry.demands.length,
        // On a sold-out day (food prepared, none left) the consumed quantity is only a LOWER BOUND on true demand.
        soldOut: entry.soldOut,
        raw: mean(entry.demands),
        firstRecordedAt: entry.recordedAt.length ? Math.min(...entry.recordedAt) : null,
    });

    // ---- index stored forecasts ----
    const forecastsByKey = new Map();
    forecasts.forEach((f) => {
        const day = toDay(f.target_date);
        if (day === null || day < startDay || day > endDay) return;
        if (!itemMeta.has(f.menu_item_id)) itemMeta.set(f.menu_item_id, { name: f.menu_item_name, unit: f.menu_item_unit });
        const key = `${f.menu_item_id}|${day}`;
        if (!forecastsByKey.has(key)) forecastsByKey.set(key, []);
        forecastsByKey.get(key).push({ ...f, createdAtMs: toTime(f.created_at) });
    });
    forecastsByKey.forEach((list) => list.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id - b.id));

    const storedView = (f, sourceLabel) => ({
        source: sourceLabel,
        predictedQuantity: r2(Number(f.predicted_quantity)),
        confidenceScore: toNumber(f.confidence_score),
        modelVersion: f.model_version || null,
        createdAt: Number.isNaN(f.createdAtMs) ? null : new Date(f.createdAtMs).toISOString(),
        expectedRange: rangeOf(f.key_factors),
    });

    // A log is known by a target day if it was recorded before that day ended (unknown timestamps are treated as known).
    const recordedLate = (entry, day) => !Number.isNaN(entry.recordedMs) && entry.recordedMs >= (day + 1) * DAY_MS;
    const historyEntriesFor = (itemId, day) => (logsByItem.get(itemId) || [])
        .filter((e) => e.day < day && !(strictAsOf && recordedLate(e, day)))
        .slice(-HISTORY_ROW_LIMIT);

    // ---- pair every forecast with its actual ----
    const skipped = { insufficientHistory: 0, storedAfterOutcome: 0 };
    let reconstructedUsingLateLogs = 0;
    const records = [];
    const evals = [];
    const keys = [...new Set([...actualByKey.keys(), ...forecastsByKey.keys()])]
        .map((key) => {
            const [itemId, day] = key.split('|').map(Number);
            return { key, itemId, day };
        })
        .sort((a, b) => a.day - b.day || a.itemId - b.itemId);

    keys.forEach(({ key, itemId, day }) => {
        const meta = itemMeta.get(itemId) || { name: null, unit: null };
        const base = { menuItemId: itemId, menuItemName: meta.name, unit: meta.unit, targetDate: fromDay(day) };
        const stored = forecastsByKey.get(key) || [];
        const entry = actualByKey.get(key);

        if (!entry) {
            if (stored.length === 0) return;
            const latest = stored[stored.length - 1];
            records.push({ ...base, status: day >= todayDay ? 'awaiting_actual' : 'missing_actual', forecast: storedView(latest, 'stored'), actual: null, error: null });
            return;
        }

        const actual = actualOf(entry);
        // A forecast only counts as prospective if it existed before the outcome was first recorded.
        const madeInTime = (f) => !strictAsOf || Number.isNaN(f.createdAtMs) || f.createdAtMs < (day + 1) * DAY_MS;
        const prospective = stored.filter((f) => (actual.firstRecordedAt === null || f.createdAtMs <= actual.firstRecordedAt) && madeInTime(f)).pop();

        let forecast;
        if (prospective) {
            forecast = storedView(prospective, 'stored');
        } else if (source === 'all') {
            // Same inputs the live forecast would have had: earlier logs plus the calendar events known by that day.
            const historyEntries = historyEntriesFor(itemId, day);
            const built = buildForecast(historyEntries.map((e) => e.row), fromDay(day), { events });
            if (built.modelVersion === FALLBACK_MODEL_VERSION) {
                skipped.insufficientHistory += 1;
                return;
            }
            const lateLogsUsed = historyEntries.filter((e) => recordedLate(e, day)).length;
            if (lateLogsUsed > 0) reconstructedUsingLateLogs += 1;
            forecast = {
                source: 'reconstructed',
                predictedQuantity: built.predictedQuantity,
                confidenceScore: built.confidenceScore,
                modelVersion: built.modelVersion,
                createdAt: null,
                expectedRange: rangeOf(built.keyFactors),
                lateRecordedLogsUsed: lateLogsUsed,
            };
        } else {
            if (stored.length > 0) skipped.storedAfterOutcome += 1;
            return;
        }

        const metrics = errorMetrics(forecast.predictedQuantity, actual.raw);
        const { raw: _raw, firstRecordedAt: _first, ...actualView } = actual;
        records.push({ ...base, status: 'evaluated', forecast, actual: actualView, error: metrics.view });
        evals.push({ ...metrics, day, itemId, source: forecast.source, range: forecast.expectedRange });
    });

    // ---- summary, trend, weekly, per item ----
    const overall = aggregate(evals);
    const missingActualCount = records.filter((r) => r.status === 'missing_actual').length;
    const pendingCount = records.filter((r) => r.status === 'awaiting_actual').length;
    const summary = {
        ...overall,
        pendingCount,
        missingActualCount,
        bySource: {
            stored: compact(aggregate(evals.filter((e) => e.source === 'stored'))),
            reconstructed: compact(aggregate(evals.filter((e) => e.source === 'reconstructed'))),
        },
        skipped,
        reconstructedUsingLateLogs,
    };

    const trend = computeTrend(evals);

    const weeks = new Map();
    evals.forEach((e) => {
        const start = weekStartOf(e.day);
        if (!weeks.has(start)) weeks.set(start, []);
        weeks.get(start).push(e);
    });
    const weekly = [...weeks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([start, list]) => {
            const agg = aggregate(list);
            return { weekStart: fromDay(start), evaluatedCount: agg.evaluatedCount, mae: agg.mae, wape: agg.wape, accuracyPercentage: agg.accuracyPercentage };
        });

    const perItem = new Map();
    evals.forEach((e) => {
        if (!perItem.has(e.itemId)) perItem.set(e.itemId, []);
        perItem.get(e.itemId).push(e);
    });
    const byMenuItem = [...perItem.entries()]
        .map(([itemId, list]) => {
            const agg = aggregate(list);
            const meta = itemMeta.get(itemId) || {};
            return {
                menuItemId: itemId, name: meta.name, unit: meta.unit, evaluatedCount: agg.evaluatedCount, mae: agg.mae,
                wape: agg.wape, bias: agg.bias, biasPercentage: agg.biasPercentage, accuracyPercentage: agg.accuracyPercentage,
            };
        })
        .sort((a, b) => b.evaluatedCount - a.evaluatedCount || compareText(a.name || '', b.name || '') || a.menuItemId - b.menuItemId);

    records.sort((a, b) => compareText(b.targetDate, a.targetDate) || compareText(a.menuItemName || '', b.menuItemName || '') || a.menuItemId - b.menuItemId);

    // ---- intervention linkage ----
    const interventionItems = recommendations
        .map((rec) => {
            const day = toDay(rec.target_date);
            if (day === null || day < startDay || day > endDay) return null;
            const key = `${rec.menu_item_id}|${day}`;
            const entry = actualByKey.get(key);
            const actual = entry ? actualOf(entry) : null;
            const createdAtMs = toTime(rec.created_at);
            // The forecast a recommendation was based on is the latest one created at/before the recommendation.
            const basis = (forecastsByKey.get(key) || []).filter((f) => Number.isNaN(createdAtMs) || f.createdAtMs <= createdAtMs).pop();
            const meta = itemMeta.get(rec.menu_item_id) || { name: rec.menu_item_name, unit: rec.menu_item_unit };
            const recommended = toNumber(rec.recommended_quantity);
            const excess = toNumber(rec.estimated_excess);
            const forecastError = basis && actual ? errorMetrics(Number(basis.predicted_quantity), actual.raw).view : null;
            const score = toNumber(rec.effectiveness_score);

            return {
                recommendationId: rec.id,
                menuItemId: rec.menu_item_id,
                menuItemName: meta.name || rec.menu_item_name,
                unit: meta.unit || rec.menu_item_unit,
                targetDate: fromDay(day),
                managerAction: rec.status,
                riskLevel: rec.risk_level || null,
                recommendedQuantity: recommended,
                estimatedExcess: excess,
                originalPlannedQuantity: recommended !== null && excess !== null ? r2(recommended + excess) : null,
                forecast: basis
                    ? { linked: true, forecastId: basis.id, predictedQuantity: r2(Number(basis.predicted_quantity)), confidenceScore: toNumber(basis.confidence_score), modelVersion: basis.model_version || null }
                    : { linked: false },
                actual: actual
                    ? { preparedQuantity: actual.preparedQuantity, consumedQuantity: actual.consumedQuantity, leftoverQuantity: actual.leftoverQuantity }
                    : null,
                forecastError,
                outcome: score === null
                    ? { evaluated: false, effectivenessScore: null, evaluatedAt: null }
                    : { evaluated: true, effectivenessScore: r2(score), evaluatedAt: rec.evaluated_at ? new Date(rec.evaluated_at).toISOString() : null },
            };
        })
        .filter(Boolean)
        .sort((a, b) => compareText(b.targetDate, a.targetDate) || a.recommendationId - b.recommendationId);

    const insights = buildInsights({ summary, trend, byMenuItem });

    return {
        period: { startDate: period.startDate, endDate: period.endDate },
        source,
        summary,
        trend,
        weekly,
        byMenuItem,
        records: records.slice(0, MAX_RECORDS),
        recordsTruncated: records.length > MAX_RECORDS,
        interventions: { summary: summariseEffectiveness(interventionItems), items: interventionItems },
        insights,
        meta: {
            definitions: {
                actual: 'Consumed quantity from daily logs: the logged consumed quantity, or prepared minus leftover. Multiple meal-slot logs on one day are averaged, as the forecast does.',
                error: 'Predicted minus actual (positive = over-prediction). Percentage errors are relative to the actual quantity.',
                wape: 'Total absolute error divided by total actual quantity.',
                accuracy: '100 minus WAPE, never below 0.',
                stored: 'A forecast that was saved before the outcome was first recorded.',
                reconstructed: 'What the model would have predicted using only logs dated before the target date (used when no earlier forecast was saved).',
            },
            historyAsOf: {
                mode: strictAsOf ? 'recorded_at' : 'log_date',
                description: strictAsOf
                    ? 'Strict point-in-time: reconstructed forecasts use only logs recorded before the end of the target day, and a saved forecast is prospective only if it was made before its target day ended.'
                    : 'Reconstructed forecasts use every log dated before the target date, even if it was entered later. reconstructedUsingLateLogs counts forecasts that relied on such logs; use historyAsOf=recorded_at for a strict point-in-time evaluation.',
            },
            notes: [
                'predictedQuantity includes the forecast\'s 5% safety buffer, so a small positive bias is expected.',
                'Forecasts based on fewer than 3 days of history are not reconstructed; only saved forecasts are compared in that case.',
                'On days flagged soldOut (nothing left over), consumed quantity is only a lower bound on true demand, so an apparent over-prediction there may be correct.',
            ],
        },
    };
}

function rangeOf(keyFactors) {
    const range = keyFactors && keyFactors.expected_range;
    if (!range || !Number.isFinite(Number(range.low)) || !Number.isFinite(Number(range.high))) return null;
    return { low: Number(range.low), high: Number(range.high) };
}

function localToday(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Always scoped to the authenticated user's own organization; no organization id is ever taken from the client.
async function getForecastPerformance(actingUser, { startDate, endDate, menuItemId, source, historyAsOf } = {}) {
    if (!actingUser.organizationId) {
        throw new AppError(403, 'This account is not associated with an organization');
    }
    const organizationId = actingUser.organizationId;

    let itemId = null;
    if (menuItemId !== undefined && menuItemId !== null && menuItemId !== '') {
        const item = await menuItemModel.findById(Number(menuItemId));
        if (!item) throw new AppError(404, 'Menu item not found');
        if (item.kitchen_org_id !== organizationId) throw new AppError(403, 'You do not have permission to perform this action');
        itemId = item.id;
    }

    const today = localToday();
    const effectiveEnd = endDate || today;
    const effectiveStart = startDate || fromDay(toDay(effectiveEnd) - (DEFAULT_WINDOW_DAYS - 1));
    if (effectiveStart > effectiveEnd) {
        throw new AppError(400, 'startDate must not be after endDate');
    }
    const historyStart = fromDay(toDay(effectiveStart) - HISTORY_LOOKBACK_DAYS);

    const eventsStart = fromDay(toDay(effectiveStart) - EVENT_LOOKBACK_DAYS);

    const [logs, forecasts, recommendations, events] = await Promise.all([
        forecastPerformanceModel.listLogs(organizationId, { fromDate: historyStart, toDate: effectiveEnd, menuItemId: itemId }),
        forecastPerformanceModel.listForecasts(organizationId, { startDate: effectiveStart, endDate: effectiveEnd, menuItemId: itemId }),
        forecastPerformanceModel.listDecidedRecommendations(organizationId, { startDate: effectiveStart, endDate: effectiveEnd, menuItemId: itemId }),
        forecastPerformanceModel.listEvents(organizationId, { fromDate: eventsStart, toDate: effectiveEnd }),
    ]);

    const result = computeForecastPerformance({
        logs,
        forecasts,
        recommendations,
        events,
        period: { startDate: effectiveStart, endDate: effectiveEnd },
        today,
        source: source === 'stored' ? 'stored' : 'all',
        historyAsOf: historyAsOf === 'recorded_at' ? 'recorded_at' : 'log_date',
    });
    result.period.defaulted = !startDate && !endDate;
    return result;
}

module.exports = { computeForecastPerformance, getForecastPerformance };
