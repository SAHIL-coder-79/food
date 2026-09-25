'use strict';

const { buildForecast, computeLegacyForecast } = require('../../src/ai/forecastEngine');

// Deterministic PRNG so every backtest is reproducible.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeGaussian(rng) {
    return function gaussian() {
        const u = Math.max(rng(), 1e-12);
        const v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
}

function addDays(dateStr, n) {
    return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function weekdayOfDate(dateStr) {
    return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Generates one daily_logs-shaped row per day for a single menu item, plus the hidden trueDemand.
 * Rows use the same fields the SQL in ai/forecasting.js returns.
 */
function generateSeries({
    seed = 1,
    days = 84,
    start = '2026-01-05', // a Monday
    base = 100,
    weekday = [1, 1, 1, 1, 1, 1, 1], // multiplier per weekday, index 0 = Sunday
    trendPerDay = 0,
    noiseCv = 0.08,
    levelShiftAt = null,
    levelShiftFactor = 1,
    headcount = null, // { base, weekday, cv, perPerson, perPersonCv }
    overplan = [1.05, 1.35],
    stockoutRate = 0,
} = {}) {
    const rng = mulberry32(seed);
    const gaussian = makeGaussian(rng);
    const rows = [];

    for (let t = 0; t < days; t += 1) {
        const date = addDays(start, t);
        const wd = weekdayOfDate(date);
        let demand;
        let heads = null;

        if (headcount) {
            const hcWeekday = headcount.weekday || [1, 1, 1, 1, 1, 1, 1];
            heads = Math.max(1, Math.round(headcount.base * hcWeekday[wd] * (1 + headcount.cv * gaussian())));
            demand = headcount.perPerson * heads * (1 + (headcount.perPersonCv ?? 0.04) * gaussian()) * (1 + trendPerDay * t);
        } else {
            demand = base * (1 + trendPerDay * t) * weekday[wd] * (levelShiftAt !== null && t >= levelShiftAt ? levelShiftFactor : 1) * (1 + noiseCv * gaussian());
        }
        demand = Math.max(0, demand);

        const stockout = rng() < stockoutRate;
        const prepared = stockout ? demand * (0.8 + 0.18 * rng()) : demand * (overplan[0] + (overplan[1] - overplan[0]) * rng());
        const consumed = Math.min(prepared, demand);
        const leftover = prepared - consumed;

        rows.push({
            id: t + 1,
            log_date: date,
            meal_slot: 'LUNCH',
            quantity_planned: round1(prepared),
            quantity_prepared: round1(prepared),
            quantity_leftover: round1(leftover),
            quantity_consumed: round1(consumed),
            headcount: heads,
            consumed: round1(prepared) - round1(leftover),
            trueDemand: demand,
        });
    }
    return rows;
}

function summarise(errors, truths) {
    const n = errors.length;
    const abs = errors.map(Math.abs);
    return {
        n,
        mae: abs.reduce((s, v) => s + v, 0) / n,
        mape: (abs.reduce((s, v, i) => s + (truths[i] > 0 ? v / truths[i] : 0), 0) / n) * 100,
        bias: errors.reduce((s, v) => s + v, 0) / n,
    };
}

/**
 * Walk-forward backtest: every day after `warmup` is forecast using ONLY earlier days, for both the
 * previous algorithm (computeLegacyForecast) and the new engine. Errors are measured against the
 * hidden true demand. With oracleHeadcount, the new engine is also given that day's real headcount
 * as expectedHeadcount (what a kitchen that knows tomorrow's attendance could supply).
 */
function runBacktest(rows, { warmup = 21, oracleHeadcount = false } = {}) {
    const truths = [];
    const legacyErrors = [];
    const nextErrors = [];
    const oracleErrors = [];
    let inRange = 0;
    const confidences = [];
    const nextAbsErrors = [];

    for (let i = warmup; i < rows.length; i += 1) {
        const target = rows[i].log_date;
        const history = rows.slice(0, i);
        const truth = rows[i].trueDemand;
        truths.push(truth);

        legacyErrors.push(computeLegacyForecast(history, target).predictedQuantity - truth);

        const next = buildForecast(history, target);
        nextErrors.push(next.predictedQuantity - truth);
        nextAbsErrors.push(Math.abs(next.predictedQuantity - truth));
        confidences.push(next.confidenceScore);
        const range = next.keyFactors.expected_range;
        if (range && truth >= range.low && truth <= range.high) inRange += 1;

        if (oracleHeadcount && rows[i].headcount) {
            oracleErrors.push(buildForecast(history, target, { expectedHeadcount: rows[i].headcount }).predictedQuantity - truth);
        }
    }

    return {
        legacy: summarise(legacyErrors, truths),
        next: { ...summarise(nextErrors, truths), coverage80: inRange / truths.length },
        oracle: oracleErrors.length ? summarise(oracleErrors, truths) : null,
        confidences,
        nextAbsErrors,
    };
}

module.exports = { mulberry32, makeGaussian, addDays, weekdayOfDate, generateSeries, runBacktest };
