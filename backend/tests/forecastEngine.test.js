const {
    buildForecast,
    computeLegacyForecast,
    normalizeTargetDate,
    MODEL_VERSION,
    FALLBACK_MODEL_VERSION,
} = require('../src/ai/forecastEngine');
const { mulberry32, generateSeries, runBacktest, addDays } = require('./helpers/forecastFixtures');

const WEEKDAY_PATTERN = [0.65, 1.15, 1.1, 1.0, 1.0, 1.05, 0.75]; // Sun..Sat

// Noise-free rows from explicit daily demand values, starting Monday 2026-03-02.
function rowsFromValues(values, { start = '2026-03-02', headcounts = null } = {}) {
    return values.map((v, i) => ({
        id: i + 1,
        log_date: addDays(start, i),
        meal_slot: 'LUNCH',
        quantity_planned: v * 1.2,
        quantity_prepared: v * 1.2,
        quantity_leftover: v * 0.2,
        quantity_consumed: v,
        consumed: v * 1.2 - v * 0.2,
        headcount: headcounts ? headcounts[i] : null,
    }));
}

function shuffled(rows, seed) {
    const rng = mulberry32(seed);
    const copy = rows.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function collectNumbers(value, out = []) {
    if (typeof value === 'number') out.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectNumbers(v, out));
    return out;
}

describe('forecast engine - insufficient data fallback', () => {
    it('returns the deterministic fallback with no history', () => {
        const result = buildForecast([], '2026-03-10');
        expect(result.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(result.predictedQuantity).toBe(0);
        expect(result.confidenceScore).toBe(0.3);
        expect(result.keyFactors.reason).toBe('Insufficient historical data');
        expect(result.keyFactors.data_points).toBe(0);
    });

    it('averages prepared quantity with fewer than 3 days of history (unchanged behavior)', () => {
        const rows = [
            { log_date: '2026-03-01', quantity_prepared: 100, consumed: 90 },
            { log_date: '2026-03-02', quantity_prepared: 110, consumed: 100 },
        ];
        const result = buildForecast(rows, '2026-03-10');
        expect(result.modelVersion).toBe('heuristic_fallback_v1');
        expect(result.predictedQuantity).toBe(105);
        expect(result.confidenceScore).toBe(0.3);
        expect(result.keyFactors.data_points).toBe(2);
    });

    it('matches the previous algorithm exactly in the fallback regime', () => {
        const rows = [
            { log_date: '2026-03-01', quantity_prepared: 80, consumed: 70 },
            { log_date: '2026-03-02', quantity_prepared: 95, consumed: 90 },
        ];
        const legacy = computeLegacyForecast(rows, '2026-03-10');
        const next = buildForecast(rows, '2026-03-10');
        expect(next.predictedQuantity).toBe(legacy.predictedQuantity);
        expect(next.confidenceScore).toBe(legacy.confidenceScore);
        expect(next.modelVersion).toBe(legacy.modelVersion);
        expect(next.keyFactors.reason).toBe(legacy.keyFactors.reason);
    });

    it('counts days, not rows: two days of multi-slot logs still fall back', () => {
        const rows = [
            { log_date: '2026-03-01', meal_slot: 'LUNCH', quantity_prepared: 100, consumed: 90 },
            { log_date: '2026-03-01', meal_slot: 'DINNER', quantity_prepared: 60, consumed: 50 },
            { log_date: '2026-03-02', meal_slot: 'LUNCH', quantity_prepared: 100, consumed: 90 },
        ];
        const result = buildForecast(rows, '2026-03-10');
        expect(result.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(result.keyFactors.data_points).toBe(3);
    });

    it('ignores unusable rows and falls back when nothing usable remains', () => {
        const rows = [
            { log_date: 'not-a-date', quantity_prepared: 100, consumed: 90 },
            { log_date: '2026-03-01', quantity_prepared: 10, quantity_leftover: 50, consumed: -40 },
            null,
            { log_date: '2026-03-02' },
        ];
        const result = buildForecast(rows, '2026-03-10');
        expect(result.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(result.predictedQuantity).toBe(0);
        expect(result.keyFactors.data_quality.invalid_rows_ignored).toBe(4);
    });

    it('switches to the context-aware model at 3 days and labels it a statistical model', () => {
        const result = buildForecast(rowsFromValues([100, 100, 100]), '2026-03-10');
        expect(result.modelVersion).toBe(MODEL_VERSION);
        expect(result.modelVersion).toBe('stat_context_v2');
        expect(result.modelVersion.toLowerCase()).not.toMatch(/ml|neural|learn/);
        expect(result.keyFactors.method).toMatch(/Not machine learning/);
    });
});

describe('forecast engine - weekday effect', () => {
    const rows = generateSeries({ seed: 11, days: 55, weekday: WEEKDAY_PATTERN, noiseCv: 0.02 }); // ends Sat 2026-02-28

    it('forecasts a busy weekday higher than a quiet one from identical history', () => {
        const sunday = buildForecast(rows, '2026-03-01');
        const monday = buildForecast(rows, '2026-03-02');
        expect(monday.predictedQuantity / sunday.predictedQuantity).toBeGreaterThan(1.5);
        // true Monday demand is ~115 (+5% buffer)
        expect(Math.abs(monday.predictedQuantity - 115 * 1.05)).toBeLessThan(115 * 1.05 * 0.08);
        expect(monday.keyFactors.signals.weekday.weekday).toBe('Monday');
        expect(monday.keyFactors.signals.weekday.index).toBeGreaterThan(1.05);
        expect(monday.keyFactors.signals.weekday.active).toBe(true);
        expect(sunday.keyFactors.signals.weekday.index).toBeLessThan(0.85);
    });

    it('applies no weekday adjustment to flat data', () => {
        const flat = generateSeries({ seed: 12, days: 55, noiseCv: 0.02 });
        const monday = buildForecast(flat, '2026-03-02');
        const sunday = buildForecast(flat, '2026-03-01');
        expect(Math.abs(monday.predictedQuantity - sunday.predictedQuantity) / sunday.predictedQuantity).toBeLessThan(0.05);
        expect(Math.abs(monday.keyFactors.signals.weekday.index - 1)).toBeLessThan(0.05);
    });

    it('is computed on the calendar date, independent of the server timezone', () => {
        expect(buildForecast(rows, '2026-03-02').keyFactors.signals.weekday.weekday).toBe('Monday');
        expect(buildForecast(rows, '2026-09-16').keyFactors.signals.weekday.weekday).toBe('Wednesday');
    });
});

describe('forecast engine - trend', () => {
    it('applies a rising trend when demand grows steadily', () => {
        const values = Array.from({ length: 30 }, (_, i) => 100 + 2 * i); // next day would be 160
        const result = buildForecast(rowsFromValues(values), '2026-04-01');
        const { trend } = result.keyFactors.signals;
        expect(trend.direction).toBe('rising');
        expect(trend.applied).toBe(true);
        expect(trend.multiplier).toBeGreaterThan(1.05);
        expect(result.keyFactors.trend_multiplier).toBe(trend.multiplier);
        expect(Math.abs(result.predictedQuantity - 160 * 1.05)).toBeLessThan(160 * 1.05 * 0.12);
        // a trend-blind average would sit far below
        expect(result.predictedQuantity).toBeGreaterThan(result.keyFactors.recent_avg * 1.05 * 1.05);
    });

    it('applies a falling trend when demand shrinks steadily', () => {
        const values = Array.from({ length: 30 }, (_, i) => 200 - 2 * i);
        const result = buildForecast(rowsFromValues(values), '2026-04-01');
        expect(result.keyFactors.signals.trend.direction).toBe('falling');
        expect(result.keyFactors.signals.trend.multiplier).toBeLessThan(0.95);
    });

    it('does not chase noise: flat noisy demand gets (almost) no trend adjustment', () => {
        [21, 22, 23, 24, 25].forEach((seed) => {
            const flat = generateSeries({ seed, days: 60, noiseCv: 0.08 });
            const result = buildForecast(flat, '2026-03-10');
            expect(Math.abs(result.keyFactors.trend_multiplier - 1)).toBeLessThan(0.06);
        });
    });

    it('caps the trend multiplier to avoid wild swings', () => {
        const values = Array.from({ length: 30 }, (_, i) => 10 * 1.15 ** i);
        const result = buildForecast(rowsFromValues(values), '2026-04-01');
        expect(result.keyFactors.trend_multiplier).toBeLessThanOrEqual(1.2);
    });
});

describe('forecast engine - attendance / context effect', () => {
    const headcountConfig = { base: 100, weekday: [0.5, 1.1, 1.1, 1.0, 1.0, 0.9, 0.6], cv: 0.15, perPerson: 0.9, perPersonCv: 0.03 };
    const rows = generateSeries({ seed: 31, days: 56, headcount: headcountConfig });
    const target = '2026-03-03'; // Tuesday, day after the history ends

    it('scales the forecast with a provided expected headcount', () => {
        const low = buildForecast(rows, target, { expectedHeadcount: 60 });
        const high = buildForecast(rows, target, { expectedHeadcount: 140 });
        expect(high.predictedQuantity / low.predictedQuantity).toBeGreaterThan(1.6);
        expect(Math.abs(high.predictedQuantity - 0.9 * 140 * 1.05)).toBeLessThan(0.9 * 140 * 1.05 * 0.25);
        const attendance = high.keyFactors.signals.attendance;
        expect(attendance.used).toBe(true);
        expect(attendance.expected_headcount_source).toBe('provided');
        expect(attendance.evidence).toBe('strong');
        expect(attendance.demand_headcount_correlation).toBeGreaterThan(0.8);
    });

    it('estimates typical headcount from history when none is provided', () => {
        const result = buildForecast(rows, target);
        const attendance = result.keyFactors.signals.attendance;
        expect(attendance.used).toBe(true);
        expect(attendance.expected_headcount_source).toBe('historical_weekday_pattern');
        expect(result.keyFactors.reason).toMatch(/Attendance signal/);
    });

    it('does not use attendance without enough headcount history, and says so', () => {
        const sparse = rows.map((r, i) => ({ ...r, headcount: i < 4 ? r.headcount : null }));
        const without = buildForecast(sparse, target);
        const withProvided = buildForecast(sparse, target, { expectedHeadcount: 500 });
        expect(withProvided.predictedQuantity).toBe(without.predictedQuantity);
        expect(withProvided.keyFactors.signals.attendance.used).toBe(false);
        expect(withProvided.keyFactors.signals.attendance.reason).toMatch(/Not enough attendance history/);
        expect(withProvided.keyFactors.reason).toMatch(/expected headcount was not used/);
    });

    it('treats attendance as weak evidence when headcount never varies, capping its weight', () => {
        const constantHeadcount = generateSeries({ seed: 32, days: 40, headcount: { ...headcountConfig, cv: 0, weekday: [1, 1, 1, 1, 1, 1, 1] } });
        const result = buildForecast(constantHeadcount, '2026-02-15', { expectedHeadcount: 150 });
        const attendance = result.keyFactors.signals.attendance;
        expect(attendance.evidence).toBe('weak');
        expect(attendance.attendance_weight).toBeLessThanOrEqual(0.4);
    });

    it('barely reacts to headcount when demand does not depend on it', () => {
        const rng = mulberry32(33);
        const unrelated = generateSeries({ seed: 33, days: 50, noiseCv: 0.03 }).map((r) => ({
            ...r,
            headcount: Math.round(60 + rng() * 80),
        }));
        const low = buildForecast(unrelated, '2026-02-25', { expectedHeadcount: 50 });
        const high = buildForecast(unrelated, '2026-02-25', { expectedHeadcount: 200 });
        expect(Math.abs(high.predictedQuantity - low.predictedQuantity) / low.predictedQuantity).toBeLessThan(0.2);
        expect(high.keyFactors.signals.attendance.attendance_weight).toBeLessThanOrEqual(0.2);
    });

    it('flags an expected headcount outside anything seen in history and lowers confidence', () => {
        const inside = buildForecast(rows, target, { expectedHeadcount: 100 });
        const outside = buildForecast(rows, target, { expectedHeadcount: 900 });
        expect(outside.keyFactors.signals.attendance.outside_observed_range).toBe(true);
        expect(inside.keyFactors.signals.attendance.outside_observed_range).toBe(false);
        expect(outside.confidenceScore).toBeLessThan(inside.confidenceScore);
    });

    it('ignores non-positive expected headcounts', () => {
        expect(buildForecast(rows, target, { expectedHeadcount: 0 })).toEqual(buildForecast(rows, target));
        expect(buildForecast(rows, target, { expectedHeadcount: -5 })).toEqual(buildForecast(rows, target));
    });
});

describe('forecast engine - target-date leakage prevention', () => {
    const history = generateSeries({ seed: 41, days: 40, weekday: WEEKDAY_PATTERN, noiseCv: 0.05 });
    const target = addDays('2026-01-05', 40);

    it('ignores rows dated on or after the target date', () => {
        const poison = [0, 1, 2, 3].map((offset) => ({
            id: 1000 + offset,
            log_date: addDays(target, offset),
            meal_slot: 'LUNCH',
            quantity_prepared: 99999,
            quantity_leftover: 0,
            quantity_consumed: 99999,
            headcount: 1,
            consumed: 99999,
        }));
        const clean = buildForecast(history, target);
        const polluted = buildForecast([...history, ...poison], target);
        expect(polluted.predictedQuantity).toBe(clean.predictedQuantity);
        expect(polluted.confidenceScore).toBe(clean.confidenceScore);
        expect(polluted.keyFactors.central_estimate).toBe(clean.keyFactors.central_estimate);
        expect(polluted.keyFactors.leakage_guard.future_rows_excluded).toBe(4);
        expect(clean.keyFactors.leakage_guard.future_rows_excluded).toBe(0);
    });

    it("forecasting a past date from full history equals forecasting it from only what was known then", () => {
        const pastTarget = addDays('2026-01-05', 30);
        const fullHistory = buildForecast(history, pastTarget);
        const knownThen = buildForecast(history.filter((r) => r.log_date < pastTarget), pastTarget);

        // Everything that describes the forecast is identical; only the bookkeeping of how many
        // later rows were received-and-discarded differs.
        const forecastOnly = ({ keyFactors, ...rest }) => {
            const { leakage_guard: guard, data_quality: quality, ...factors } = keyFactors;
            const { rows_received: received, ...qualityRest } = quality;
            return { ...rest, keyFactors: { ...factors, data_quality: qualityRest } };
        };
        expect(forecastOnly(fullHistory)).toEqual(forecastOnly(knownThen));
        expect(fullHistory.keyFactors.leakage_guard.future_rows_excluded).toBe(10);
        expect(knownThen.keyFactors.leakage_guard.future_rows_excluded).toBe(0);
    });

    it("the target day's own outcome never influences its forecast", () => {
        const withOutcome = history.map((r) => (r.log_date === addDays('2026-01-05', 39) ? { ...r, quantity_consumed: 5000, consumed: 5000 } : r));
        const lastDayTarget = addDays('2026-01-05', 39);
        expect(buildForecast(withOutcome, lastDayTarget)).toEqual(buildForecast(history, lastDayTarget));
    });
});

describe('forecast engine - determinism', () => {
    const rows = generateSeries({
        seed: 51,
        days: 50,
        headcount: { base: 100, weekday: [0.5, 1.1, 1.1, 1.0, 1.0, 0.9, 0.6], cv: 0.15, perPerson: 0.9 },
    });
    const target = '2026-03-01';

    it('returns identical output for identical input, repeatedly', () => {
        const first = buildForecast(rows, target, { expectedHeadcount: 90 });
        for (let i = 0; i < 5; i += 1) {
            expect(buildForecast(rows, target, { expectedHeadcount: 90 })).toEqual(first);
        }
        expect(JSON.stringify(buildForecast(rows, target))).toBe(JSON.stringify(buildForecast(rows, target)));
    });

    it('does not depend on the order of the input rows', () => {
        const baseline = buildForecast(rows, target);
        [1, 2, 3].forEach((seed) => {
            expect(buildForecast(shuffled(rows, seed), target)).toEqual(baseline);
        });
    });

    it('does not depend on the order of multiple meal-slot logs on the same day', () => {
        const multi = rows.flatMap((r) => [r, { ...r, id: r.id + 5000, meal_slot: 'DINNER', quantity_consumed: r.quantity_consumed * 0.6, consumed: r.consumed * 0.6 }]);
        expect(buildForecast(shuffled(multi, 7), target)).toEqual(buildForecast(multi, target));
    });

    it('does not consult the clock or randomness', () => {
        const realNow = Date.now;
        const realRandom = Math.random;
        Date.now = () => { throw new Error('clock used'); };
        Math.random = () => { throw new Error('randomness used'); };
        try {
            expect(() => buildForecast(rows, target)).not.toThrow();
        } finally {
            Date.now = realNow;
            Math.random = realRandom;
        }
    });
});

describe('forecast engine - confidence behavior', () => {
    it('grows with the amount of history', () => {
        const long = generateSeries({ seed: 61, days: 60, noiseCv: 0.08 });
        const short = long.slice(0, 8);
        const longConfidence = buildForecast(long, '2026-03-10').confidenceScore;
        const shortConfidence = buildForecast(short, addDays('2026-01-05', 8)).confidenceScore;
        expect(longConfidence).toBeGreaterThan(shortConfidence);
    });

    it('falls as the data gets noisier', () => {
        const calm = generateSeries({ seed: 62, days: 45, noiseCv: 0.03 });
        const wild = generateSeries({ seed: 62, days: 45, noiseCv: 0.4 });
        const target = addDays('2026-01-05', 45);
        expect(buildForecast(calm, target).confidenceScore).toBeGreaterThan(buildForecast(wild, target).confidenceScore);
    });

    it('falls when the forecast is far beyond the last observation', () => {
        const rows = generateSeries({ seed: 63, days: 45, noiseCv: 0.08 });
        const near = buildForecast(rows, addDays('2026-01-05', 45));
        const far = buildForecast(rows, addDays('2026-01-05', 80));
        expect(far.confidenceScore).toBeLessThan(near.confidenceScore);
        expect(far.keyFactors.history.days_since_last_observation).toBe(36);
    });

    it('falls when many days sold out (demand under-recorded)', () => {
        const rows = generateSeries({ seed: 64, days: 45, noiseCv: 0.05 });
        const soldOut = rows.map((r) => ({ ...r, quantity_leftover: 0 }));
        const target = addDays('2026-01-05', 45);
        const normal = buildForecast(rows, target);
        const constrained = buildForecast(soldOut, target);
        expect(constrained.keyFactors.data_quality.stockout_days).toBe(45);
        expect(constrained.confidenceScore).toBeLessThan(normal.confidenceScore);
    });

    it('stays within [0.35, 0.95] for the main model and above the 0.3 fallback score', () => {
        [generateSeries({ seed: 65, days: 120, noiseCv: 0.001 }), generateSeries({ seed: 66, days: 5, noiseCv: 0.9 })].forEach((rows) => {
            const result = buildForecast(rows, addDays('2026-01-05', rows.length));
            expect(result.confidenceScore).toBeGreaterThanOrEqual(0.35);
            expect(result.confidenceScore).toBeLessThanOrEqual(0.95);
        });
    });

    it('explains its confidence, and reports an expected range that contains the estimate', () => {
        const rows = generateSeries({ seed: 67, days: 40, noiseCv: 0.08 });
        const { keyFactors, confidenceScore } = buildForecast(rows, addDays('2026-01-05', 40));
        expect(keyFactors.forecast_confidence.score).toBe(confidenceScore);
        expect(Object.keys(keyFactors.forecast_confidence.components)).toEqual(['data_volume', 'stability', 'recency', 'data_quality']);
        expect(keyFactors.expected_range.low).toBeLessThanOrEqual(keyFactors.central_estimate);
        expect(keyFactors.expected_range.high).toBeGreaterThanOrEqual(keyFactors.central_estimate);
    });

    it('a wider expected range accompanies noisier data', () => {
        const target = addDays('2026-01-05', 45);
        const calm = buildForecast(generateSeries({ seed: 68, days: 45, noiseCv: 0.03 }), target).keyFactors;
        const wild = buildForecast(generateSeries({ seed: 68, days: 45, noiseCv: 0.3 }), target).keyFactors;
        const width = (kf) => (kf.expected_range.high - kf.expected_range.low) / kf.central_estimate;
        expect(width(wild)).toBeGreaterThan(width(calm));
    });
});

describe('forecast engine - very distant target dates', () => {
    // Recency weights (0.5 ** (age / 14)) used to underflow to exactly 0 after ~40 years, collapsing the forecast to 0.
    const rows = generateSeries({ seed: 91, days: 30, noiseCv: 0 }); // flat 100, ends 2026-02-03

    it('does not collapse to zero for a target date decades away', () => {
        const near = buildForecast(rows, '2026-02-04');
        [ '2050-01-01', '2099-06-15', '9999-12-31' ].forEach((target) => {
            const far = buildForecast(rows, target);
            expect(far.modelVersion).toBe('stat_context_v2');
            expect(far.predictedQuantity).toBe(105);
            expect(far.predictedQuantity).toBe(near.predictedQuantity);
            collectNumbers(far).forEach((n) => expect(Number.isFinite(n)).toBe(true));
        });
    });

    it('still reflects the data (and lowers confidence for the stale history) at extreme horizons', () => {
        const far = buildForecast(rows, '2099-06-15');
        const near = buildForecast(rows, '2026-02-04');
        expect(far.confidenceScore).toBeLessThan(near.confidenceScore);
        expect(far.keyFactors.history.days_since_last_observation).toBeGreaterThan(20000);
    });

    it('leaves every realistic horizon unchanged (no age shift below ~4 years)', () => {
        const a = buildForecast(rows, '2026-02-04');
        const b = buildForecast(rows, '2030-01-01');
        expect(a.predictedQuantity).toBe(105);
        expect(b.predictedQuantity).toBe(105);
    });
});

describe('forecast engine - explainability and compatibility', () => {
    const rows = generateSeries({
        seed: 71,
        days: 50,
        weekday: WEEKDAY_PATTERN,
        headcount: { base: 100, weekday: WEEKDAY_PATTERN, cv: 0.1, perPerson: 0.9 },
    });
    const result = buildForecast(rows, '2026-03-01');

    it('keeps the four existing response fields with their existing types', () => {
        expect(Object.keys(result).sort()).toEqual(['confidenceScore', 'keyFactors', 'modelVersion', 'predictedQuantity']);
        expect(typeof result.predictedQuantity).toBe('number');
        expect(typeof result.confidenceScore).toBe('number');
        expect(typeof result.modelVersion).toBe('string');
        expect(typeof result.keyFactors).toBe('object');
    });

    it('keeps the legacy keyFactors keys and rounding', () => {
        ['recent_avg', 'weekday_avg', 'trend_multiplier', 'safety_buffer', 'data_points_used'].forEach((key) => {
            expect(result.keyFactors).toHaveProperty(key);
        });
        expect(result.keyFactors.safety_buffer).toBe('5%');
        expect(result.keyFactors.data_points_used).toBe(50);
        expect(result.predictedQuantity).toBe(Math.round(result.predictedQuantity * 10) / 10);
    });

    it('reports the historical, weekday, attendance and trend signals plus a reason', () => {
        const { signals, reason, history, data_quality: dataQuality } = result.keyFactors;
        expect(Object.keys(signals).sort()).toEqual(['attendance', 'historical_demand', 'trend', 'weekday']);
        expect(signals.historical_demand.observations).toBe(50);
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(40);
        expect(history.last_date).toBe('2026-02-23'); // 50 days from 2026-01-05
        expect(dataQuality.rows_received).toBe(50);
    });

    it('predicted quantity is the central estimate plus the 5% safety buffer', () => {
        expect(Math.abs(result.predictedQuantity - result.keyFactors.central_estimate * 1.05)).toBeLessThan(0.11);
    });

    it('is safe to persist as JSON (no NaN/Infinity, no undefined-only shapes)', () => {
        collectNumbers(result).forEach((n) => expect(Number.isFinite(n)).toBe(true));
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });
});

describe('forecast engine - multi meal-slot days and robustness', () => {
    it('averages multiple meal-slot logs of one day into one per-serving observation', () => {
        const rows = [];
        for (let i = 0; i < 12; i += 1) {
            const date = addDays('2026-03-02', i);
            rows.push({ id: i * 2 + 1, log_date: date, meal_slot: 'LUNCH', quantity_consumed: 100, consumed: 100 });
            rows.push({ id: i * 2 + 2, log_date: date, meal_slot: 'DINNER', quantity_consumed: 60, consumed: 60 });
        }
        const result = buildForecast(rows, '2026-03-20');
        expect(result.keyFactors.data_points_used).toBe(12);
        expect(result.keyFactors.data_quality.multi_log_days_averaged).toBe(12);
        expect(result.keyFactors.central_estimate).toBeCloseTo(80, 0);
    });

    it('prefers the logged consumed quantity over prepared minus leftover', () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({
            log_date: addDays('2026-03-02', i),
            quantity_prepared: 200,
            quantity_leftover: 100,
            quantity_consumed: 70,
            consumed: 100,
        }));
        expect(buildForecast(rows, '2026-03-20').keyFactors.central_estimate).toBeCloseTo(70, 0);
    });

    it('survives garbage rows without throwing or emitting non-finite numbers', () => {
        const garbage = [
            null,
            undefined,
            'row',
            {},
            { log_date: '2026-02-30', consumed: 5 },
            { log_date: '2026-03-01', consumed: 'abc' },
            { log_date: '2026-03-02', consumed: NaN },
            { log_date: '2026-03-03', consumed: -4 },
            { log_date: new Date('2026-03-04T00:00:00'), consumed: 50, headcount: 'x' },
            { log_date: '2026-03-05', consumed: '55', headcount: '0' },
            { log_date: '2026-03-06', quantity_consumed: 0 },
            { log_date: '2026-03-07', quantity_consumed: 0 },
            { log_date: '2026-03-08', quantity_consumed: 0 },
        ];
        let result;
        expect(() => { result = buildForecast(garbage, '2026-03-10'); }).not.toThrow();
        collectNumbers(result).forEach((n) => expect(Number.isFinite(n)).toBe(true));
        expect(result.predictedQuantity).toBeGreaterThanOrEqual(0);
    });

    it('handles an all-zero history', () => {
        const result = buildForecast(rowsFromValues(new Array(10).fill(0)), '2026-03-20');
        expect(result.predictedQuantity).toBe(0);
        collectNumbers(result).forEach((n) => expect(Number.isFinite(n)).toBe(true));
    });

    it('rejects impossible target dates and normalises valid ones', () => {
        expect(() => buildForecast([], '2026-02-30')).toThrow(/Invalid targetDate/);
        expect(() => buildForecast([], 'tomorrow')).toThrow(/Invalid targetDate/);
        expect(normalizeTargetDate('2026-09-16')).toBe('2026-09-16');
        expect(normalizeTargetDate('2026-09-16T23:30:00Z')).toBe('2026-09-16');
        expect(normalizeTargetDate('2026-13-01')).toBeNull();
        expect(normalizeTargetDate('16-09-2026')).toBeNull();
        expect(normalizeTargetDate(42)).toBeNull();
        expect(normalizeTargetDate(undefined)).toBeNull();
    });
});

describe('forecast engine vs previous algorithm (walk-forward backtest, synthetic data)', () => {
    const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

    function averaged(config, options = {}) {
        const acc = { legacy: 0, next: 0, oracle: 0, coverage: 0 };
        SEEDS.forEach((seed) => {
            const result = runBacktest(generateSeries({ seed, ...config }), options);
            acc.legacy += result.legacy.mae;
            acc.next += result.next.mae;
            acc.oracle += result.oracle ? result.oracle.mae : 0;
            acc.coverage += result.next.coverage80;
        });
        const k = SEEDS.length;
        return { legacy: acc.legacy / k, next: acc.next / k, oracle: acc.oracle / k, coverage: acc.coverage / k };
    }

    it('is no worse on flat demand', () => {
        const r = averaged({ days: 84, noiseCv: 0.08 });
        expect(r.next).toBeLessThanOrEqual(r.legacy);
    });

    it('is much better when demand has a weekday pattern', () => {
        const r = averaged({ days: 84, weekday: WEEKDAY_PATTERN, noiseCv: 0.08 });
        expect(r.next).toBeLessThan(r.legacy * 0.6);
    });

    it('is better on rising and falling trends', () => {
        expect(averaged({ days: 84, trendPerDay: 0.005 }).next).toBeLessThan(averaged({ days: 84, trendPerDay: 0.005 }).legacy * 0.95);
        const falling = averaged({ days: 84, trendPerDay: -0.004 });
        expect(falling.next).toBeLessThan(falling.legacy * 0.9);
    });

    it('is much better with weekday pattern plus trend, and with stockout-censored data', () => {
        const combined = averaged({ days: 84, weekday: WEEKDAY_PATTERN, trendPerDay: 0.004 });
        expect(combined.next).toBeLessThan(combined.legacy * 0.6);
        const censored = averaged({ days: 84, weekday: WEEKDAY_PATTERN, stockoutRate: 0.2 });
        expect(censored.next).toBeLessThan(censored.legacy * 0.6);
    });

    it('is no worse after a sudden level shift', () => {
        const r = averaged({ days: 84, levelShiftAt: 50, levelShiftFactor: 1.3 });
        expect(r.next).toBeLessThanOrEqual(r.legacy);
    });

    it('is better on short histories', () => {
        const r = averaged({ days: 14, weekday: WEEKDAY_PATTERN }, { warmup: 5 });
        expect(r.next).toBeLessThan(r.legacy);
    });

    it('is better on attendance-driven demand, and far better when attendance is known in advance', () => {
        const config = { days: 84, headcount: { base: 100, weekday: [0.5, 1.1, 1.1, 1.0, 1.0, 0.9, 0.6], cv: 0.15, perPerson: 0.9, perPersonCv: 0.04 } };
        const r = averaged(config, { oracleHeadcount: true });
        expect(r.next).toBeLessThan(r.legacy * 0.75);
        expect(r.oracle).toBeLessThan(r.legacy * 0.4);
        expect(r.oracle).toBeLessThan(r.next);
    });

    it('reports an expected range whose empirical coverage is close to its nominal 80%', () => {
        const r = averaged({ days: 84, weekday: WEEKDAY_PATTERN, noiseCv: 0.08 });
        expect(r.coverage).toBeGreaterThan(0.68);
        expect(r.coverage).toBeLessThan(0.92);
    });

    it('assigns higher confidence to series it forecasts more accurately', () => {
        const calm = runBacktest(generateSeries({ seed: 9, days: 84, weekday: WEEKDAY_PATTERN, noiseCv: 0.04 }));
        const wild = runBacktest(generateSeries({ seed: 9, days: 84, weekday: WEEKDAY_PATTERN, noiseCv: 0.35 }));
        const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
        expect(mean(calm.confidences)).toBeGreaterThan(mean(wild.confidences));
        expect(calm.next.mae).toBeLessThan(wild.next.mae);
    });
});
