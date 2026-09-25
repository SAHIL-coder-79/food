const {
    buildForecast,
    computeLegacyForecast,
    expectedRangeOf,
    MODEL_VERSION,
    FALLBACK_MODEL_VERSION,
    CONFIDENCE_TYPE,
    CONSTANTS,
} = require('../src/ai/forecastEngine');
const { computeForecastPerformance } = require('../src/services/forecastPerformanceService');
const { mulberry32, generateSeries, addDays } = require('./helpers/forecastFixtures');

const START = '2026-03-02'; // a Monday
const WEEKDAY_PATTERN = [0.65, 1.15, 1.1, 1.0, 1.0, 1.05, 0.75];

const NO_CORRECTION = { adjustForSoldOut: false };

// Deterministic per-day demand around `level` (+-4).
const demandAt = (i, level = 100) => level + (((i * 7) % 5) - 2) * 2;

/**
 * One LUNCH log per day. Days in `soldOut` sold out: everything prepared was consumed, nothing left, and the consumed
 * quantity is `soldOutFactor` of what a normal day would have consumed (demand was cut short).
 */
function buildRows(count, { soldOut = [], level = 100, soldOutFactor = 0.9, start = START, slots = ['LUNCH'], soldOutSlots = null } = {}) {
    const rows = [];
    let id = 1;
    for (let i = 0; i < count; i += 1) {
        slots.forEach((slot, slotIndex) => {
            const demand = demandAt(i, level) * (slotIndex === 0 ? 1 : 0.6);
            const sells = soldOut.includes(i) && (soldOutSlots === null || soldOutSlots.includes(slot));
            const consumed = sells ? demand * soldOutFactor : demand;
            const prepared = sells ? consumed : demand * 1.2;
            rows.push({
                id: id++,
                log_date: addDays(start, i),
                meal_slot: slot,
                quantity_planned: prepared,
                quantity_prepared: prepared,
                quantity_leftover: prepared - consumed,
                quantity_consumed: consumed,
                consumed: prepared - (prepared - consumed),
                headcount: null,
            });
        });
    }
    return rows;
}

const SOLD_OUT_DAYS = [3, 7, 11, 15, 19, 23]; // ~1 in 4 of 24 days
const TARGET = addDays(START, 24);
const central = (result) => result.keyFactors.central_estimate;
const relativeWidth = (result) => (result.keyFactors.expected_range.high - result.keyFactors.expected_range.low) / result.keyFactors.central_estimate;

function shuffled(rows, seed) {
    const rng = mulberry32(seed);
    const copy = rows.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// ---------------------------------------------------------------------------
// 1. Sold-out / censored demand
// ---------------------------------------------------------------------------

describe('hardening 1 - sold-out (censored) demand', () => {
    it('changes nothing when no day sold out, and says so', () => {
        const rows = buildRows(24);
        const on = buildForecast(rows, TARGET);
        const off = buildForecast(rows, TARGET, NO_CORRECTION);
        expect(on.predictedQuantity).toBe(off.predictedQuantity);
        expect(on.confidenceScore).toBe(off.confidenceScore);
        expect(on.keyFactors.expected_range).toEqual(off.keyFactors.expected_range);
        expect(on.keyFactors.demand_censoring).toMatchObject({ status: 'none_detected', sold_out_days: 0, adjusted_days: 0, demand_lift_pct: 0 });
    });

    // Exact outputs recorded from the engine BEFORE this hardening, on synthetic series with no sold-out day. Any change to
    // forecasts for data without sold-out days is a regression.
    const HEADCOUNT = { base: 100, weekday: WEEKDAY_PATTERN, cv: 0.1, perPerson: 0.9 };
    it.each([
        ['flat, 30 days', { seed: 1, days: 30 }, 110.7, 0.81, { low: 95.8, high: 115.1 }],
        ['weekday pattern, 60 days', { seed: 2, days: 60, weekday: WEEKDAY_PATTERN }, 69.2, 0.77, { low: 58.1, high: 73.7 }],
        ['weekday + trend, 84 days', { seed: 3, days: 84, weekday: WEEKDAY_PATTERN, trendPerDay: 0.004 }, 159.3, 0.79, { low: 136.3, high: 167.2 }],
        ['attendance-driven, 50 days', { seed: 4, days: 50, headcount: HEADCOUNT }, 94.3, 0.72, { low: 75.5, high: 104 }],
        ['noisy short history, 12 days', { seed: 5, days: 12, noiseCv: 0.2 }, 119.9, 0.51, { low: 82.4, high: 146 }],
    ])('is exactly the pre-hardening output when no day sold out: %s', (_name, config, predicted, confidence, range) => {
        const { seed, ...series } = config;
        const rows = generateSeries({ seed, ...series });
        const result = buildForecast(rows, addDays('2026-01-05', series.days + (seed % 3)));
        expect(result.modelVersion).toBe(MODEL_VERSION);
        expect(result.keyFactors.data_quality.stockout_days).toBe(0);
        expect(result.predictedQuantity).toBe(predicted);
        expect(result.confidenceScore).toBe(confidence);
        expect(result.keyFactors.expected_range).toMatchObject(range);
        expect(result.keyFactors.demand_censoring.status).toBe('none_detected');
    });

    it('treats sold-out days as a lower bound: lifts demand when there is enough evidence', () => {
        const rows = buildRows(24, { soldOut: SOLD_OUT_DAYS });
        const on = buildForecast(rows, TARGET);
        const off = buildForecast(rows, TARGET, NO_CORRECTION);
        expect(on.keyFactors.demand_censoring).toMatchObject({ status: 'adjusted', sold_out_days: 6, adjusted_days: 6, reason: null });
        expect(on.keyFactors.demand_censoring.demand_lift_pct).toBeGreaterThan(0);
        expect(central(on)).toBeGreaterThan(central(off));
        expect(on.predictedQuantity).toBeGreaterThan(off.predictedQuantity);
        expect(on.keyFactors.reason).toMatch(/6 sold-out day\(s\) were treated as a lower bound/);
    });

    it('never lowers a day, and never lifts one by more than the cap', () => {
        // 10 of 24 days sold out after consuming only 40% of a normal day. Restoring them to ~100 would lift recency-weighted
        // demand by ~30% (measured: 29.5% without the cap); the per-day cap (25% of what was consumed) must bind instead.
        const capBinds = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
        const rows = buildRows(24, { soldOut: capBinds, soldOutFactor: 0.4 });
        const on = buildForecast(rows, TARGET);
        const off = buildForecast(rows, TARGET, NO_CORRECTION);
        expect(on.keyFactors.demand_censoring.status).toBe('adjusted');
        expect(on.keyFactors.demand_censoring.adjusted_days).toBe(10);
        expect(central(on)).toBeGreaterThanOrEqual(central(off));
        expect(central(on) / central(off)).toBeLessThanOrEqual(1 + CONSTANTS.CENSOR_MAX_UPLIFT);
        expect(on.keyFactors.demand_censoring.demand_lift_pct).toBeGreaterThan(2); // it did lift (measured: 4.9%)...
        expect(on.keyFactors.demand_censoring.demand_lift_pct).toBeLessThan(10); // ...but nowhere near restoring the full shortfall
    });

    it('lifts a day more when it sold out at a higher quantity (monotone, never on its own baseline)', () => {
        const lowSell = buildForecast(buildRows(24, { soldOut: SOLD_OUT_DAYS, soldOutFactor: 0.7 }), TARGET);
        const highSell = buildForecast(buildRows(24, { soldOut: SOLD_OUT_DAYS, soldOutFactor: 0.98 }), TARGET);
        expect(central(highSell)).toBeGreaterThan(central(lowSell));
    });

    it('gets closer to the true demand than ignoring the censoring (synthetic walk-forward, unbuffered estimate)', () => {
        const bias = (options) => {
            let signed = 0;
            let truth = 0;
            for (let seed = 1; seed <= 6; seed += 1) {
                const rows = generateSeries({ seed, days: 70, weekday: WEEKDAY_PATTERN, stockoutRate: 0.25 });
                for (let i = 21; i < rows.length; i += 1) {
                    signed += central(buildForecast(rows.slice(0, i), rows[i].log_date, options)) - rows[i].trueDemand;
                    truth += rows[i].trueDemand;
                }
            }
            return signed / truth;
        };
        const ignored = bias(NO_CORRECTION);
        const corrected = bias({});
        expect(ignored).toBeLessThan(-0.015); // ignoring the censoring under-forecasts
        expect(Math.abs(corrected)).toBeLessThan(Math.abs(ignored));
    });

    it('stays conservative without evidence: exact planning (leftover always 0) is not treated as sold out', () => {
        const rows = buildRows(24).map((r) => ({ ...r, quantity_prepared: r.quantity_consumed, quantity_leftover: 0 }));
        const on = buildForecast(rows, TARGET);
        const off = buildForecast(rows, TARGET, NO_CORRECTION);
        expect(on.keyFactors.demand_censoring.status).toBe('not_adjusted');
        expect(on.keyFactors.demand_censoring.reason).toMatch(/cannot be told apart from exact planning/);
        expect(on.keyFactors.demand_censoring.adjusted_days).toBe(0);
        expect(on.predictedQuantity).toBe(off.predictedQuantity);
        expect(on.keyFactors.expected_range.note).toMatch(/widened/);
        expect(on.keyFactors.reason).toMatch(/could not be corrected/);
    });

    it('stays conservative with too few normal days that recorded leftover', () => {
        // 4 normal days with leftover (< 5 needed) and 6 sold-out days.
        const rows = buildRows(10, { soldOut: [0, 2, 4, 6, 8, 9] });
        const result = buildForecast(rows, addDays(START, 10));
        expect(result.modelVersion).toBe(MODEL_VERSION);
        expect(result.keyFactors.demand_censoring.status).toBe('not_adjusted');
        expect(result.keyFactors.demand_censoring.reason).toMatch(/Only 4 normal day\(s\) recorded leftover/);
        expect(result.predictedQuantity).toBe(buildForecast(rows, addDays(START, 10), NO_CORRECTION).predictedQuantity);
    });

    it('stays conservative when most days sold out, but widens the range and lowers confidence', () => {
        // 14 of 24 days sold out (58% > 50%), with 10 normal days that did record leftover.
        const soldOut = [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
        const rows = buildRows(24, { soldOut });
        const result = buildForecast(rows, TARGET);
        expect(result.keyFactors.demand_censoring.status).toBe('not_adjusted');
        expect(result.keyFactors.demand_censoring.reason).toMatch(/too many/);
        expect(result.predictedQuantity).toBe(buildForecast(rows, TARGET, NO_CORRECTION).predictedQuantity);
        const clean = buildForecast(buildRows(24), TARGET);
        expect(relativeWidth(result)).toBeGreaterThan(relativeWidth(clean));
        expect(result.confidenceScore).toBeLessThan(clean.confidenceScore);
    });

    it('does not call a day sold out when food is unaccounted for, but keeps the existing stockout signal', () => {
        // No leftover recorded, yet consumption is only 70% of what was prepared: the rest was wasted or mis-logged.
        const rows = buildRows(24).map((r, i) => (SOLD_OUT_DAYS.includes(i)
            ? { ...r, quantity_prepared: r.quantity_consumed / 0.7, quantity_leftover: 0 }
            : r));
        const result = buildForecast(rows, TARGET);
        expect(result.keyFactors.data_quality.stockout_days).toBe(6); // unchanged data-quality signal
        expect(result.keyFactors.demand_censoring).toMatchObject({ status: 'none_detected', sold_out_days: 0, unconfirmed_zero_leftover_days: 6, adjusted_days: 0 });
        expect(result.predictedQuantity).toBe(buildForecast(rows, TARGET, NO_CORRECTION).predictedQuantity);
    });

    it('is less sure about a corrected history than about a clean one: wider range, no higher confidence', () => {
        // Same underlying demand; in one history six days were cut short and had to be imputed.
        const corrected = buildForecast(buildRows(24, { soldOut: SOLD_OUT_DAYS, soldOutFactor: 0.85 }), TARGET);
        const clean = buildForecast(buildRows(24), TARGET);
        expect(corrected.keyFactors.demand_censoring.status).toBe('adjusted');
        expect(relativeWidth(corrected)).toBeGreaterThan(relativeWidth(clean));
        expect(corrected.confidenceScore).toBeLessThanOrEqual(clean.confidenceScore);
        // ...and the corrected level lands close to the clean one (it recovers the demand that was cut short).
        expect(Math.abs(central(corrected) - central(clean)) / central(clean)).toBeLessThan(0.03);
    });

    it('never produces non-finite numbers, even with awkward sold-out inputs', () => {
        const awkward = [
            ...buildRows(20, { soldOut: [1, 2, 3, 4, 5] }),
            { log_date: addDays(START, 20), quantity_prepared: 0, quantity_leftover: 0, quantity_consumed: 0 },
            { log_date: addDays(START, 21), quantity_prepared: 50, quantity_leftover: 0, quantity_consumed: 0 },
            { log_date: addDays(START, 22), quantity_prepared: 1e9, quantity_leftover: 0, quantity_consumed: 1e9 },
        ];
        const result = buildForecast(awkward, addDays(START, 30));
        const numbers = [];
        (function walk(v) { if (typeof v === 'number') numbers.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }(result));
        numbers.forEach((n) => expect(Number.isFinite(n)).toBe(true));
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });
});

describe('hardening 1 - sold-out correction and multiple meal slots', () => {
    const slots = ['LUNCH', 'DINNER'];
    const days = 24;

    it('keeps the per-serving average unit: two slots are still averaged into one value per day', () => {
        const result = buildForecast(buildRows(days, { slots }), TARGET);
        // LUNCH ~100, DINNER ~60 -> ~80 per slot, exactly as before (not 160).
        expect(central(result)).toBeGreaterThan(70);
        expect(central(result)).toBeLessThan(90);
        expect(result.keyFactors.data_quality.multi_log_days_averaged).toBe(days);
        expect(result.keyFactors.data_points_used).toBe(days);
    });

    it('lifts a day only in proportion to the slots that actually sold out', () => {
        const lunchOnly = buildForecast(buildRows(days, { slots, soldOut: SOLD_OUT_DAYS, soldOutSlots: ['LUNCH'] }), TARGET);
        const bothSlots = buildForecast(buildRows(days, { slots, soldOut: SOLD_OUT_DAYS, soldOutSlots: ['LUNCH', 'DINNER'] }), TARGET);
        expect(lunchOnly.keyFactors.demand_censoring.status).toBe('adjusted');
        expect(bothSlots.keyFactors.demand_censoring.status).toBe('adjusted');
        expect(lunchOnly.keyFactors.demand_censoring.demand_lift_pct).toBeGreaterThan(0);
        expect(bothSlots.keyFactors.demand_censoring.demand_lift_pct).toBeGreaterThan(lunchOnly.keyFactors.demand_censoring.demand_lift_pct);
        // Half the slots sold out on those days, so the lift is capped at half the per-day cap.
        expect(lunchOnly.keyFactors.demand_censoring.demand_lift_pct).toBeLessThanOrEqual((CONSTANTS.CENSOR_MAX_UPLIFT / 2) * 100 + 0.05);
    });

    it('keeps the forecast in the same units after correction (still a per-slot average)', () => {
        const off = buildForecast(buildRows(days, { slots, soldOut: SOLD_OUT_DAYS, soldOutSlots: ['LUNCH'] }), TARGET, NO_CORRECTION);
        const on = buildForecast(buildRows(days, { slots, soldOut: SOLD_OUT_DAYS, soldOutSlots: ['LUNCH'] }), TARGET);
        expect(central(on) / central(off)).toBeGreaterThanOrEqual(1);
        expect(central(on) / central(off)).toBeLessThan(1.125 + 0.001);
        expect(on.keyFactors.data_points_used).toBe(days);
    });

    it('counts meal-slot days, not rows, when deciding whether history is sufficient', () => {
        const rows = buildRows(2, { slots, soldOut: [0, 1] });
        const result = buildForecast(rows, addDays(START, 5));
        expect(result.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(result.keyFactors.data_points).toBe(4);
    });
});

describe('hardening 1 - determinism and leakage of the sold-out correction', () => {
    const rows = buildRows(24, { soldOut: SOLD_OUT_DAYS, soldOutFactor: 0.85 });

    it('is deterministic and independent of row order', () => {
        const first = buildForecast(rows, TARGET);
        expect(buildForecast(rows, TARGET)).toEqual(first);
        expect(buildForecast(shuffled(rows, 7), TARGET)).toEqual(first);
        expect(buildForecast(shuffled(rows, 99), TARGET)).toEqual(first);
    });

    it('never uses rows dated on or after the target date, including sold-out ones', () => {
        const before = buildForecast(rows, TARGET);
        const poison = [0, 1, 2, 3, 4, 5].map((k) => ({
            log_date: addDays(TARGET, k),
            meal_slot: 'LUNCH',
            quantity_prepared: 5000,
            quantity_leftover: 0,
            quantity_consumed: 5000,
            consumed: 5000,
        }));
        const after = buildForecast([...rows, ...poison], TARGET);
        expect(after.predictedQuantity).toBe(before.predictedQuantity);
        expect(after.confidenceScore).toBe(before.confidenceScore);
        expect(after.keyFactors.demand_censoring).toEqual(before.keyFactors.demand_censoring);
        expect(after.keyFactors.expected_range).toEqual(before.keyFactors.expected_range);
    });

    it('a forecast for a past day equals the forecast made from only what was known then', () => {
        const longSeries = buildRows(40, { soldOut: [3, 7, 11, 15, 19, 23, 27, 31, 35] });
        const day = 28;
        const fromFull = buildForecast(longSeries, addDays(START, day));
        const fromKnown = buildForecast(longSeries.filter((r) => r.log_date < addDays(START, day)), addDays(START, day));
        // Everything that describes the forecast is identical; only the bookkeeping of how many later rows were dropped differs.
        expect(fromFull.keyFactors.leakage_guard.future_rows_excluded).toBe(12);
        const withoutBookkeeping = (result) => {
            const copy = JSON.parse(JSON.stringify(result));
            delete copy.keyFactors.leakage_guard.future_rows_excluded;
            delete copy.keyFactors.data_quality.rows_received;
            return copy;
        };
        expect(withoutBookkeeping(fromFull)).toEqual(withoutBookkeeping(fromKnown));
    });

    it('a sold-out day after the correction date can never influence an earlier forecast', () => {
        const calm = buildRows(30);
        const withLateSoldOut = calm.map((r, i) => (i >= 24 ? { ...r, quantity_prepared: r.quantity_consumed, quantity_leftover: 0 } : r));
        const target = addDays(START, 24);
        expect(buildForecast(withLateSoldOut, target)).toEqual(buildForecast(calm, target));
    });
});

// ---------------------------------------------------------------------------
// 2. Prevention compatibility: expected range + unchanged predictedQuantity
// ---------------------------------------------------------------------------

describe('hardening 2 - expected range exposure', () => {
    it('expectedRangeOf returns a clearly labelled demand range for the statistical forecast', () => {
        const forecast = buildForecast(buildRows(24), TARGET);
        const range = expectedRangeOf(forecast);
        expect(range).toMatchObject({ coverage: 0.8, basis: 'demand_before_safety_buffer', safetyBufferPct: 5 });
        expect(range.low).toBe(forecast.keyFactors.expected_range.low);
        expect(range.high).toBe(forecast.keyFactors.expected_range.high);
        expect(range.low).toBeLessThanOrEqual(range.high);
        expect(range.low).toBeGreaterThanOrEqual(0);
        expect(range.note).toMatch(/not a guarantee/);
    });

    it('labels the basis inside keyFactors.expected_range too, keeping the existing fields', () => {
        const range = buildForecast(buildRows(24), TARGET).keyFactors.expected_range;
        expect(Object.keys(range).sort()).toEqual(['basis', 'coverage', 'high', 'low', 'note']);
        expect(range.basis).toBe('demand_before_safety_buffer');
    });

    it('has no range for the fallback forecast (null, never invented)', () => {
        const fallback = buildForecast(buildRows(2), TARGET);
        expect(fallback.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(fallback.keyFactors.expected_range).toBeUndefined();
        expect(expectedRangeOf(fallback)).toBeNull();
        expect(expectedRangeOf(null)).toBeNull();
        expect(expectedRangeOf({})).toBeNull();
    });

    it('preserves predictedQuantity as the central estimate plus the 5% safety buffer and the four response fields', () => {
        const result = buildForecast(buildRows(24, { soldOut: SOLD_OUT_DAYS }), TARGET);
        expect(Object.keys(result).sort()).toEqual(['confidenceScore', 'keyFactors', 'modelVersion', 'predictedQuantity']);
        expect(Math.abs(result.predictedQuantity - result.keyFactors.central_estimate * 1.05)).toBeLessThan(0.11);
        expect(result.keyFactors.safety_buffer).toBe('5%');
    });

    it('keeps the legacy predictedQuantity for data without sold-out days identical to the previous algorithm family', () => {
        const rows = buildRows(24);
        const legacy = computeLegacyForecast(rows, TARGET);
        const next = buildForecast(rows, TARGET);
        // Same scale and safety buffer: a flat series is forecast within a few percent by both.
        expect(Math.abs(next.predictedQuantity - legacy.predictedQuantity) / legacy.predictedQuantity).toBeLessThan(0.05);
    });
});

// ---------------------------------------------------------------------------
// 4. Confidence: reflects data volume and stability, and is not a probability
// ---------------------------------------------------------------------------

describe('hardening 4 - confidence', () => {
    it('is labelled as an uncalibrated heuristic in every forecast, including the fallback', () => {
        [buildForecast(buildRows(24), TARGET), buildForecast(buildRows(2), TARGET), buildForecast([], TARGET)].forEach((result) => {
            expect(result.keyFactors.forecast_confidence).toMatchObject({ type: CONFIDENCE_TYPE, calibrated: false, score: result.confidenceScore });
            expect(result.keyFactors.forecast_confidence.note).toMatch(/not a (calibrated )?probability/);
        });
        expect(CONFIDENCE_TYPE).toBe('heuristic_reliability_score');
    });

    it('rises with the volume of history (same process, more days)', () => {
        const long = generateSeries({ seed: 5, days: 80, noiseCv: 0.06 });
        const scores = [4, 8, 16, 32, 64].map((n) => buildForecast(long.slice(0, n), addDays('2026-01-05', n)).confidenceScore);
        for (let i = 1; i < scores.length; i += 1) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
        expect(scores[scores.length - 1]).toBeGreaterThan(scores[0] + 0.1);
    });

    it('falls with instability (same volume, noisier data) and with a stale history', () => {
        const target = addDays('2026-01-05', 40);
        const calm = buildForecast(generateSeries({ seed: 6, days: 40, noiseCv: 0.03 }), target).confidenceScore;
        const wild = buildForecast(generateSeries({ seed: 6, days: 40, noiseCv: 0.45 }), target).confidenceScore;
        expect(wild).toBeLessThan(calm);
        const rows = generateSeries({ seed: 6, days: 40, noiseCv: 0.05 });
        expect(buildForecast(rows, addDays('2026-01-05', 75)).confidenceScore).toBeLessThan(buildForecast(rows, target).confidenceScore);
    });

    it('depends on the shape of the data, not its unit or scale', () => {
        const rows = generateSeries({ seed: 8, days: 40, weekday: WEEKDAY_PATTERN, noiseCv: 0.08 });
        const scaled = rows.map((r) => ({
            ...r,
            quantity_planned: r.quantity_planned * 10,
            quantity_prepared: r.quantity_prepared * 10,
            quantity_leftover: r.quantity_leftover * 10,
            quantity_consumed: r.quantity_consumed * 10,
            consumed: r.consumed * 10,
        }));
        const target = addDays('2026-01-05', 40);
        const a = buildForecast(rows, target);
        const b = buildForecast(scaled, target);
        expect(b.confidenceScore).toBe(a.confidenceScore);
        expect(relativeWidth(b)).toBeCloseTo(relativeWidth(a), 2);
    });

    it('never claims certainty: bounded to [0.35, 0.95] however clean the data, and above the fallback score', () => {
        const perfect = buildForecast(buildRows(120).map((r) => ({ ...r, quantity_consumed: 100, quantity_prepared: 120, quantity_leftover: 20, consumed: 100 })), addDays(START, 120));
        expect(perfect.confidenceScore).toBeLessThanOrEqual(0.95);
        expect(perfect.confidenceScore).toBeGreaterThan(0.3);
        expect(perfect.keyFactors.expected_range.high - perfect.keyFactors.expected_range.low).toBeGreaterThan(0); // never a zero-width "certain" range
    });

    it('is lowered by sold-out days whether or not they could be corrected', () => {
        const clean = buildForecast(buildRows(24), TARGET).confidenceScore;
        expect(buildForecast(buildRows(24, { soldOut: SOLD_OUT_DAYS }), TARGET).confidenceScore).toBeLessThanOrEqual(clean);
        const uncorrectable = buildRows(24).map((r) => ({ ...r, quantity_prepared: r.quantity_consumed, quantity_leftover: 0 }));
        expect(buildForecast(uncorrectable, TARGET).confidenceScore).toBeLessThan(clean);
    });
});

// ---------------------------------------------------------------------------
// 5. Short history
// ---------------------------------------------------------------------------

describe('hardening 5 - short history keeps the existing fallback', () => {
    it('is unchanged below 3 days, even when those days sold out', () => {
        const rows = [
            { log_date: '2026-03-01', quantity_prepared: 100, quantity_leftover: 0, quantity_consumed: 100, consumed: 100 },
            { log_date: '2026-03-02', quantity_prepared: 110, quantity_leftover: 0, quantity_consumed: 110, consumed: 110 },
        ];
        const result = buildForecast(rows, '2026-03-10');
        const legacy = computeLegacyForecast(rows, '2026-03-10');
        expect(result.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(result.predictedQuantity).toBe(105);
        expect(result.predictedQuantity).toBe(legacy.predictedQuantity);
        expect(result.confidenceScore).toBe(0.3);
        expect(result.keyFactors.reason).toBe('Insufficient historical data');
        expect(result.keyFactors.demand_censoring).toBeUndefined();
        expect(result.keyFactors.expected_range).toBeUndefined();
    });

    it('switches to the statistical model at exactly 3 days, without crashing on all-sold-out history', () => {
        const rows = [0, 1, 2].map((i) => ({ log_date: addDays(START, i), quantity_prepared: 100, quantity_leftover: 0, quantity_consumed: 100, consumed: 100 }));
        const result = buildForecast(rows, addDays(START, 5));
        expect(result.modelVersion).toBe(MODEL_VERSION);
        expect(result.keyFactors.demand_censoring.status).toBe('not_adjusted');
        expect(result.predictedQuantity).toBe(buildForecast(rows, addDays(START, 5), NO_CORRECTION).predictedQuantity);
        expect(result.confidenceScore).toBeGreaterThanOrEqual(0.35);
    });

    it('is not fooled into the main model by sold-out correction on very short histories', () => {
        expect(buildForecast(buildRows(2, { soldOut: [0, 1] }), addDays(START, 4)).modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(buildForecast(buildRows(3), addDays(START, 4)).modelVersion).toBe(MODEL_VERSION);
    });

    it('keeps the fallback deterministic and the correction flag harmless there', () => {
        const rows = buildRows(2);
        expect(buildForecast(rows, TARGET, NO_CORRECTION)).toEqual(buildForecast(rows, TARGET));
    });
});

// ---------------------------------------------------------------------------
// 3. Forecast-vs-actual: no leakage in historical evaluation
// ---------------------------------------------------------------------------

describe('hardening 3 - historical forecast evaluation (forecast vs actual)', () => {
    const atUtc = (date, time = '12:00') => new Date(`${date}T${time}:00Z`);
    const PERIOD_DAY = addDays(START, 24);

    function logRow(index, base, { createdAt } = {}) {
        return {
            id: index + 1,
            menu_item_id: 1,
            menu_item_name: 'Rice',
            menu_item_unit: 'kg',
            log_date: base.log_date,
            meal_slot: base.meal_slot,
            quantity_planned: base.quantity_planned,
            quantity_prepared: base.quantity_prepared,
            quantity_leftover: base.quantity_leftover,
            quantity_consumed: base.quantity_consumed,
            headcount: null,
            // Default: each day's log is entered that evening, so it is known before the next day starts.
            created_at: createdAt || atUtc(base.log_date, '20:00'),
            consumed: base.consumed,
        };
    }

    const history = buildRows(24, { soldOut: SOLD_OUT_DAYS });
    const actualRow = { log_date: PERIOD_DAY, meal_slot: 'LUNCH', quantity_planned: 120, quantity_prepared: 120, quantity_leftover: 15, quantity_consumed: 105, consumed: 105 };

    const compute = (logs, extra = {}) => computeForecastPerformance({
        logs,
        forecasts: [],
        recommendations: [],
        period: { startDate: PERIOD_DAY, endDate: PERIOD_DAY },
        today: addDays(PERIOD_DAY, 30),
        ...extra,
    });

    const liveLogs = [...history.map((r, i) => logRow(i, r)), logRow(history.length, actualRow)];

    it('reconstructs the same forecast the live engine gives from earlier logs, sold-out correction included', () => {
        const record = compute(liveLogs).records[0];
        const live = buildForecast(history, PERIOD_DAY);
        expect(record.forecast.source).toBe('reconstructed');
        expect(record.forecast.predictedQuantity).toBe(live.predictedQuantity);
        expect(record.forecast.expectedRange).toEqual({ low: live.keyFactors.expected_range.low, high: live.keyFactors.expected_range.high });
        expect(live.keyFactors.demand_censoring.status).toBe('adjusted');
    });

    it('is unaffected by any later log, including a later sold-out day', () => {
        const later = [1, 2, 3].map((k, i) => logRow(100 + i, { log_date: addDays(PERIOD_DAY, k), meal_slot: 'LUNCH', quantity_planned: 999, quantity_prepared: 999, quantity_leftover: 0, quantity_consumed: 999, consumed: 999 }));
        const plain = compute(liveLogs).records[0].forecast;
        const withLater = compute([...liveLogs, ...later]).records[0].forecast;
        expect(withLater.predictedQuantity).toBe(plain.predictedQuantity);
        expect(withLater.expectedRange).toEqual(plain.expectedRange);
    });

    it('flags sold-out actuals as a lower bound on demand and leaves normal days unflagged', () => {
        const soldOutActual = { ...actualRow, quantity_prepared: 105, quantity_leftover: 0 };
        const soldOutLogs = [...history.map((r, i) => logRow(i, r)), logRow(history.length, soldOutActual)];
        const flagged = compute(soldOutLogs);
        expect(flagged.records[0].actual.soldOut).toBe(true);
        expect(compute(liveLogs).records[0].actual.soldOut).toBe(false);
        expect(flagged.meta.notes.join(' ')).toMatch(/lower bound on true demand/);
    });

    describe('default mode (historyAsOf=log_date) is unchanged but transparent', () => {
        // The whole history was bulk-entered long after the target day.
        const bulk = [...history.map((r, i) => logRow(i, r, { createdAt: atUtc(addDays(PERIOD_DAY, 20)) })), logRow(history.length, actualRow, { createdAt: atUtc(addDays(PERIOD_DAY, 20)) })];

        it('still evaluates bulk-loaded history, and reports that it relied on late-entered logs', () => {
            const result = compute(bulk);
            expect(result.records[0].forecast.source).toBe('reconstructed');
            expect(result.records[0].forecast.predictedQuantity).toBe(buildForecast(history, PERIOD_DAY).predictedQuantity);
            expect(result.records[0].forecast.lateRecordedLogsUsed).toBe(history.length);
            expect(result.summary.reconstructedUsingLateLogs).toBe(1);
            expect(result.meta.historyAsOf.mode).toBe('log_date');
            expect(result.meta.historyAsOf.description).toMatch(/historyAsOf=recorded_at/);
        });

        it('reports zero late logs when every log was entered in time', () => {
            const result = compute(liveLogs);
            expect(result.records[0].forecast.lateRecordedLogsUsed).toBe(0);
            expect(result.summary.reconstructedUsingLateLogs).toBe(0);
        });
    });

    describe('strict point-in-time mode (historyAsOf=recorded_at)', () => {
        const strict = (logs, extra = {}) => compute(logs, { historyAsOf: 'recorded_at', ...extra });

        it('matches the default result when every log was recorded in time', () => {
            expect(strict(liveLogs).records[0].forecast).toEqual(compute(liveLogs).records[0].forecast);
            expect(strict(liveLogs).meta.historyAsOf.mode).toBe('recorded_at');
        });

        it('leaves out logs entered after the target day ended', () => {
            // The last 10 history days were only entered a week after the target day.
            const lateFrom = 14;
            const logs = [
                ...history.map((r, i) => logRow(i, r, i >= lateFrom ? { createdAt: atUtc(addDays(PERIOD_DAY, 7)) } : {})),
                logRow(history.length, actualRow),
            ];
            const onTime = history.slice(0, lateFrom);
            const record = strict(logs).records[0].forecast;
            expect(record.predictedQuantity).toBe(buildForecast(onTime, PERIOD_DAY).predictedQuantity);
            expect(record.lateRecordedLogsUsed).toBe(0);
            expect(strict(logs).summary.reconstructedUsingLateLogs).toBe(0);
            // The default mode does use them, and says so.
            expect(compute(logs).records[0].forecast.lateRecordedLogsUsed).toBe(history.length - lateFrom);
        });

        it('does not reconstruct a forecast when too little history was known at the time', () => {
            const bulk = [...history.map((r, i) => logRow(i, r, { createdAt: atUtc(addDays(PERIOD_DAY, 20)) })), logRow(history.length, actualRow, { createdAt: atUtc(addDays(PERIOD_DAY, 20)) })];
            const result = strict(bulk);
            expect(result.records).toHaveLength(0);
            expect(result.summary.skipped.insufficientHistory).toBe(1);
        });

        it('a saved forecast counts as prospective only if it was made before its target day ended', () => {
            const forecastRow = (createdAt) => ({
                id: 1, menu_item_id: 1, menu_item_name: 'Rice', menu_item_unit: 'kg', target_date: PERIOD_DAY,
                predicted_quantity: 100, confidence_score: 0.6, model_version: MODEL_VERSION, key_factors: null, created_at: createdAt,
            });
            // Outcome recorded on day+2; the forecast was saved on day+1 (after the target day, before the outcome).
            const logs = [...history.map((r, i) => logRow(i, r)), logRow(history.length, actualRow, { createdAt: atUtc(addDays(PERIOD_DAY, 2)) })];
            const afterTargetDay = forecastRow(atUtc(addDays(PERIOD_DAY, 1)));
            const beforeTargetEnds = forecastRow(atUtc(PERIOD_DAY, '08:00'));

            expect(compute(logs, { forecasts: [afterTargetDay] }).records[0].forecast.source).toBe('stored'); // default mode: unchanged
            expect(strict(logs, { forecasts: [afterTargetDay] }).records[0].forecast.source).toBe('reconstructed');
            expect(strict(logs, { forecasts: [beforeTargetEnds] }).records[0].forecast.source).toBe('stored');
        });
    });
});
