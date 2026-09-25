const { buildForecast, EVENT_TYPES } = require('../src/ai/forecastEngine');
const { computeForecastPerformance } = require('../src/services/forecastPerformanceService');
const { generateSeries, addDays } = require('./helpers/forecastFixtures');

const START = '2026-03-02'; // a Monday
const DAYS = 42; // 2026-03-02 .. 2026-04-12
const TARGET = '2026-04-14'; // a Tuesday; the day after the history ends is 04-13
const KNOWN_LONG_AGO = '2026-01-01T00:00:00Z';

// Flat demand of 100 (predicted 105 with the safety buffer), with optional per-date overrides.
function history({ days = DAYS, base = 100, overrides = {}, start = START } = {}) {
    return Array.from({ length: days }, (_, i) => {
        const date = addDays(start, i);
        const v = overrides[date] ?? base;
        return {
            id: i + 1,
            log_date: date,
            meal_slot: 'LUNCH',
            quantity_planned: v * 1.2,
            quantity_prepared: v * 1.2,
            quantity_leftover: v * 0.2,
            quantity_consumed: v,
            consumed: v,
            headcount: null,
            created_at: new Date(`${date}T20:00:00Z`),
        };
    });
}

function ev(date, type, name, impact = null, createdAt = KNOWN_LONG_AGO) {
    return { event_date: date, event_type: type, name, expected_impact_pct: impact, created_at: new Date(createdAt) };
}

// override values for a list of dates
const on = (dates, value) => Object.fromEntries(dates.map((d) => [d, value]));

const FESTIVAL_DAYS = ['2026-03-05', '2026-03-12', '2026-03-19', '2026-03-26'];
const pastEvents = (dates, type = 'festival', name = 'Festival', impact = null) => dates.map((d) => ev(d, type, name, impact));

const forecastOnly = ({ keyFactors, ...rest }) => {
    const { leakage_guard: _guard, data_quality: quality, ...factors } = keyFactors;
    const { rows_received: _received, ...qualityRest } = quality;
    return { ...rest, keyFactors: { ...factors, data_quality: qualityRest } };
};

describe('event context - no events (normal forecasts are unchanged)', () => {
    const rows = history();
    const plain = buildForecast(rows, TARGET);

    it('gives the same plain forecast, with no event_context, when there are no events', () => {
        expect(plain.predictedQuantity).toBe(105);
        expect(plain.keyFactors).not.toHaveProperty('event_context');
    });

    it.each([
        ['an empty list', []],
        ['undefined', undefined],
        ['null', null],
        ['garbage entries', [null, 'x', 42, {}, { event_date: 'nope', event_type: 'holiday' }, { event_date: TARGET }]],
    ])('is identical to the plain forecast with %s', (_label, events) => {
        expect(buildForecast(rows, TARGET, { events })).toEqual(plain);
    });

    it('ignores events that cannot matter: after the target, before any history, or informational (no impact)', () => {
        const events = [
            ev(addDays(TARGET, 1), 'festival', 'Tomorrow', 50), // after the target date
            ev('2025-12-25', 'holiday', 'Long before the history', -100), // no observation on that day
            ev('2026-03-10', 'special_meal', 'Noted only', 0), // a history day, but declared as no effect
        ];
        expect(buildForecast(rows, TARGET, { events })).toEqual(plain);
    });

    it('keeps the same keyFactors structure as before', () => {
        const withEmpty = buildForecast(rows, TARGET, { events: [] });
        expect(Object.keys(withEmpty.keyFactors)).toEqual(Object.keys(plain.keyFactors));
        expect(Object.keys(withEmpty.keyFactors.signals).sort()).toEqual(['attendance', 'historical_demand', 'trend', 'weekday']);
    });
});

describe('event context - positive (higher-demand) event', () => {
    const rows = history({ overrides: on(FESTIVAL_DAYS, 150) });
    const events = [...pastEvents(FESTIVAL_DAYS), ev(TARGET, 'festival', 'Harvest Festival')];
    const result = buildForecast(rows, TARGET, { events });
    const context = result.keyFactors.event_context;

    it('learns the uplift from similar past event days and applies it', () => {
        expect(context.adjustment).toMatchObject({ factor: 1.5, effect_pct: 50, evidence: 'learned', learned_factor: 1.5, learned_from_days: 4, event_signature: 'festival', applied_to: 'full_estimate' });
        expect(context.applied).toBe(true);
        expect(result.keyFactors.central_estimate).toBe(150);
        expect(result.predictedQuantity).toBe(157.5);
    });

    it('keeps the event days out of the baseline so ordinary days are not distorted', () => {
        expect(context.history_event_days_excluded).toBe(4);
        expect(context.adjustment.baseline_estimate).toBe(100);
        expect(result.keyFactors.data_points_used).toBe(DAYS - 4);
        expect(result.keyFactors.recent_avg).toBe(100);
    });

    it('forecasts higher than the plain model that treats event days as normal days would', () => {
        const ignoringEvents = buildForecast(rows, TARGET, { events: [] });
        expect(result.predictedQuantity).toBeGreaterThan(ignoringEvents.predictedQuantity);
    });

    it('explains the influence in keyFactors and the reason', () => {
        expect(context.target_events).toEqual([{ type: 'festival', name: 'Harvest Festival', expected_impact_pct: null }]);
        expect(result.keyFactors.reason).toMatch(/The target date has 1 event\(s\): Harvest Festival \(festival\)\./);
        expect(result.keyFactors.reason).toMatch(/4 similar past day\(s\) ran about x1\.5 of a normal day; applied x1\.5\./);
        expect(result.keyFactors.reason).toMatch(/4 past event day\(s\) were left out of the baseline/);
    });

    it('does not adjust an ordinary day just because event days exist in the history', () => {
        const ordinary = buildForecast(rows, '2026-04-13', { events });
        expect(ordinary.predictedQuantity).toBe(105);
        expect(ordinary.keyFactors.event_context).toMatchObject({ applied: false, adjustment: null, target_events: [], history_event_days_excluded: 4 });

        // Excluding the labelled days gives exactly the forecast you would get had they never been logged...
        const withoutThoseDays = buildForecast(rows.filter((r) => !FESTIVAL_DAYS.includes(r.log_date)), '2026-04-13');
        expect(ordinary.predictedQuantity).toBe(withoutThoseDays.predictedQuantity);
        expect(ordinary.keyFactors.central_estimate).toBe(withoutThoseDays.keyFactors.central_estimate);

        // ...whereas leaving the spikes in the baseline distorts even a normal day.
        const polluted = buildForecast(rows, '2026-04-13', { events: [] });
        expect(polluted.predictedQuantity).not.toBe(105);
    });
});

describe('event context - reduced-demand event', () => {
    const HOLIDAYS = ['2026-03-06', '2026-03-13', '2026-03-20'];

    it('learns a demand drop from similar past days', () => {
        const rows = history({ overrides: on(HOLIDAYS, 40) });
        const events = [...pastEvents(HOLIDAYS, 'holiday', 'Public holiday'), ev(TARGET, 'holiday', 'Public holiday')];
        const result = buildForecast(rows, TARGET, { events });
        expect(result.keyFactors.event_context.adjustment).toMatchObject({ factor: 0.4, effect_pct: -60, evidence: 'learned', learned_from_days: 3 });
        expect(result.predictedQuantity).toBe(42);
        expect(result.predictedQuantity).toBeLessThan(buildForecast(rows, TARGET).predictedQuantity);
    });

    it('applies a declared reduction when there is no history for that kind of event', () => {
        const result = buildForecast(history(), TARGET, { events: [ev(TARGET, 'exam', 'Final exams', -30)] });
        expect(result.keyFactors.event_context.adjustment).toMatchObject({ factor: 0.7, evidence: 'declared', declared_factor: 0.7, learned_factor: null, learned_from_days: 0 });
        expect(result.predictedQuantity).toBeCloseTo(73.5, 0);
    });

    it('forecasts zero for a closure that declares no demand', () => {
        const result = buildForecast(history(), TARGET, { events: [ev(TARGET, 'closure', 'Campus closed', -100)] });
        expect(result.predictedQuantity).toBe(0);
        expect(result.keyFactors.central_estimate).toBe(0);
        expect(result.keyFactors.expected_range).toMatchObject({ low: 0, high: 0 });
        expect(result.keyFactors.event_context.adjustment.factor).toBe(0);
    });

    it('never produces a negative forecast', () => {
        const rows = history({ overrides: on(HOLIDAYS, 0) });
        const events = [...pastEvents(HOLIDAYS, 'closure', 'Closed'), ev(TARGET, 'closure', 'Closed')];
        const result = buildForecast(rows, TARGET, { events });
        expect(result.predictedQuantity).toBe(0);
    });
});

describe('event context - declared expected impact vs learned evidence', () => {
    it('blends limited history toward the declared impact', () => {
        const rows = history(); // one past special meal that ran at a normal 100
        const events = [ev('2026-03-11', 'special_meal', 'Feast', null), ev(TARGET, 'special_meal', 'Feast', 50)];
        const result = buildForecast(rows, TARGET, { events });
        expect(result.keyFactors.event_context.adjustment).toMatchObject({ evidence: 'limited_history', learned_factor: 1, declared_factor: 1.5, learned_from_days: 1 });
        expect(result.keyFactors.event_context.adjustment.factor).toBeCloseTo(1.333, 3); // (1 + 2 x 1.5) / 3
        expect(result.predictedQuantity).toBeCloseTo(140, 0);
    });

    it('trusts enough history over a declared guess, but still blends it', () => {
        const days = ['2026-03-05', '2026-03-12', '2026-03-19', '2026-03-26'];
        const rows = history({ overrides: on(days, 120) });
        const events = [...pastEvents(days, 'festival', 'Fair'), ev(TARGET, 'festival', 'Fair', 50)];
        const result = buildForecast(rows, TARGET, { events });
        expect(result.keyFactors.event_context.adjustment).toMatchObject({ evidence: 'learned', learned_factor: 1.2, declared_factor: 1.5 });
        expect(result.keyFactors.event_context.adjustment.factor).toBeCloseTo(1.3, 3); // (4 x 1.2 + 2 x 1.5) / 6
        expect(result.predictedQuantity).toBeCloseTo(136.5, 0);
    });

    it('is cautious with only a little history and no declared impact', () => {
        const days = ['2026-03-05', '2026-03-12'];
        const rows = history({ overrides: on(days, 150) });
        const events = [...pastEvents(days), ev(TARGET, 'festival', 'Fair')];
        const result = buildForecast(rows, TARGET, { events });
        expect(result.keyFactors.event_context.adjustment).toMatchObject({ evidence: 'limited_history', learned_factor: 1.5 });
        expect(result.keyFactors.event_context.adjustment.factor).toBeCloseTo(1.25, 3); // (2 x 1.5 + 2 x 1) / 4
    });

    it('makes no adjustment (and says so) when an event has neither history nor a declared impact', () => {
        const plain = buildForecast(history(), TARGET);
        const result = buildForecast(history(), TARGET, { events: [ev(TARGET, 'institutional_event', 'Open day')] });
        const context = result.keyFactors.event_context;
        expect(result.predictedQuantity).toBe(plain.predictedQuantity);
        expect(context).toMatchObject({ applied: false, adjustment: { factor: 1, evidence: 'none' } });
        expect(result.keyFactors.reason).toMatch(/no adjustment was made \(the event is noted only\)/);
    });

    it('treats an event declared as having no impact as informational only', () => {
        const plain = buildForecast(history(), TARGET);
        const result = buildForecast(history(), TARGET, { events: [ev(TARGET, 'special_meal', 'Menu change', 0)] });
        expect(result.predictedQuantity).toBe(plain.predictedQuantity);
        expect(result.keyFactors.event_context).toMatchObject({ applied: false, adjustment: null, target_events: [{ type: 'special_meal', name: 'Menu change', expected_impact_pct: 0 }] });
        expect(result.keyFactors.reason).toMatch(/no expected impact, so no adjustment was made/);
        expect(result.confidenceScore).toBe(plain.confidenceScore);
    });

    it('caps an extreme declared uplift', () => {
        const result = buildForecast(history(), TARGET, { events: [ev(TARGET, 'festival', 'Mega fair', 500)] });
        expect(result.keyFactors.event_context.adjustment.factor).toBe(3);
        expect(result.predictedQuantity).toBeCloseTo(315, 0);
    });

    it('combines several events on the same day, and only learns from days with the same combination', () => {
        const days = ['2026-03-05', '2026-03-12', '2026-03-19', '2026-03-26'];
        const rows = history({ overrides: on(days, 150) });
        const events = [
            ...pastEvents(days, 'festival', 'Fair'), // festival-only days ran at 1.5x
            ev(TARGET, 'festival', 'Fair', 20),
            ev(TARGET, 'special_meal', 'Feast', 10),
        ];
        const result = buildForecast(rows, TARGET, { events });
        const adjustment = result.keyFactors.event_context.adjustment;
        expect(adjustment).toMatchObject({ event_signature: 'festival+special_meal', evidence: 'declared', learned_from_days: 0 });
        expect(adjustment.factor).toBeCloseTo(1.32, 3); // 1.2 x 1.1; the festival-only days say nothing about this combination
        expect(result.keyFactors.event_context.target_events).toHaveLength(2);
    });
});

describe('event context - target-date handling', () => {
    const rows = history({ overrides: on(FESTIVAL_DAYS, 150) });
    const events = [...pastEvents(FESTIVAL_DAYS), ev(TARGET, 'festival', 'Harvest Festival')];

    it('applies an event only to the date it is on', () => {
        expect(buildForecast(rows, TARGET, { events }).keyFactors.event_context.applied).toBe(true);
        expect(buildForecast(rows, addDays(TARGET, -1), { events }).keyFactors.event_context.applied).toBe(false);
    });

    it('ignores an event dated the day after the target', () => {
        const plain = buildForecast(history(), TARGET);
        expect(buildForecast(history(), TARGET, { events: [ev(addDays(TARGET, 1), 'closure', 'Tomorrow', -100)] })).toEqual(plain);
    });

    it('accepts full ISO timestamps and alias field names, using only the calendar date', () => {
        const canonical = buildForecast(rows, TARGET, { events });
        const aliased = buildForecast(rows, TARGET, {
            events: events.map((e) => ({ date: `${e.event_date}T00:00:00.000Z`, type: e.event_type, name: e.name, expectedImpactPct: e.expected_impact_pct, createdAt: e.created_at.toISOString() })),
        });
        expect(aliased).toEqual(canonical);
    });

    it('counts a duplicated event row once', () => {
        const single = buildForecast(history(), TARGET, { events: [ev(TARGET, 'exam', 'Finals', -30)] });
        const doubled = buildForecast(history(), TARGET, { events: [ev(TARGET, 'exam', 'Finals', -30), ev(TARGET, 'exam', 'Finals', -30)] });
        expect(doubled).toEqual(single);
    });

    it('uses the target weekday as usual alongside the event', () => {
        const result = buildForecast(rows, TARGET, { events });
        expect(result.keyFactors.signals.weekday.weekday).toBe('Tuesday');
    });

    it('rejects nothing for an impossible event date - it is simply ignored', () => {
        expect(buildForecast(history(), TARGET, { events: [ev('2026-02-30', 'closure', 'Bad date', -100)] })).toEqual(buildForecast(history(), TARGET));
    });
});

describe('event context - historical leakage protection', () => {
    const rows = history({ overrides: on(FESTIVAL_DAYS, 150) });
    const events = [...pastEvents(FESTIVAL_DAYS), ev(TARGET, 'festival', 'Harvest Festival')];

    it('never uses logs from the target date or later, even with events in play', () => {
        const poison = [0, 1, 2].map((offset) => ({
            id: 900 + offset, log_date: addDays(TARGET, offset), meal_slot: 'LUNCH', quantity_consumed: 9999, quantity_prepared: 9999,
            quantity_leftover: 0, consumed: 9999, headcount: null, created_at: new Date(`${addDays(TARGET, offset)}T20:00:00Z`),
        }));
        const clean = buildForecast(rows, TARGET, { events });
        const polluted = buildForecast([...rows, ...poison], TARGET, { events });
        expect(forecastOnly(polluted)).toEqual(forecastOnly(clean));
        expect(polluted.predictedQuantity).toBe(157.5);
    });

    it('never learns from event days after the target date', () => {
        const future = [ev(addDays(TARGET, 3), 'festival', 'Future fair', 500), ev(addDays(TARGET, 10), 'festival', 'Later fair', 500)];
        const futureRows = [...rows, ...history({ days: 12, base: 900, start: addDays(TARGET, 0) }).map((r, i) => ({ ...r, id: 500 + i }))];
        expect(forecastOnly(buildForecast(futureRows, TARGET, { events: [...events, ...future] }))).toEqual(forecastOnly(buildForecast(rows, TARGET, { events })));
    });

    it('ignores an event on the target date that was entered after that date (it may reflect the outcome)', () => {
        const plain = buildForecast(rows, TARGET, { events: [] });
        const late = ev(TARGET, 'closure', 'Recorded afterwards', -100, `${addDays(TARGET, 1)}T00:00:00Z`);
        expect(buildForecast(rows, TARGET, { events: [late] })).toEqual(plain);

        const sameDay = ev(TARGET, 'closure', 'Entered that day', -100, `${TARGET}T23:59:59Z`);
        expect(buildForecast(rows, TARGET, { events: [sameDay] }).predictedQuantity).toBe(0);
    });

    it('ignores past-day labels that were only added after the target date', () => {
        const relabelled = pastEvents(FESTIVAL_DAYS).map((e) => ({ ...e, created_at: new Date(`${addDays(TARGET, 5)}T00:00:00Z`) }));
        const withLateLabels = buildForecast(rows, TARGET, { events: relabelled });
        expect(withLateLabels).toEqual(buildForecast(rows, TARGET, { events: [] })); // event days stay in the baseline, exactly as with no events
        expect(withLateLabels.keyFactors).not.toHaveProperty('event_context');
    });

    it('uses only events known by each day when reconstructing historical forecasts', () => {
        const target = '2026-03-16';
        // 03-02 .. 03-16: the last day is the actual for the target date
        const logs = history({ days: 15 }).map((r) => ({ ...r, menu_item_id: 1, menu_item_name: 'Rice', menu_item_unit: 'kg' }));
        const period = { startDate: target, endDate: target };
        const known = ev(target, 'closure', 'Announced in advance', -100, '2026-03-01T00:00:00Z');
        const retro = ev(target, 'closure', 'Added after the fact', -100, '2026-03-30T00:00:00Z');

        const withKnown = computeForecastPerformance({ logs, events: [known], period, today: '2026-04-01' });
        const withRetro = computeForecastPerformance({ logs, events: [retro], period, today: '2026-04-01' });
        const without = computeForecastPerformance({ logs, events: [], period, today: '2026-04-01' });
        expect(withKnown.records[0].forecast.predictedQuantity).toBe(0);
        expect(withRetro.records[0].forecast.predictedQuantity).toBe(105);
        expect(withRetro.records[0].forecast).toEqual(without.records[0].forecast);
    });
});

describe('event context - determinism', () => {
    const rows = history({ overrides: on(FESTIVAL_DAYS, 150) });
    const events = [...pastEvents(FESTIVAL_DAYS), ev(TARGET, 'festival', 'Harvest Festival', 20)];

    it('returns identical output for identical input, in any row or event order', () => {
        const baseline = buildForecast(rows, TARGET, { events });
        expect(buildForecast(rows, TARGET, { events })).toEqual(baseline);
        expect(buildForecast(rows.slice().reverse(), TARGET, { events: events.slice().reverse() })).toEqual(baseline);
        expect(JSON.stringify(buildForecast(rows, TARGET, { events }))).toBe(JSON.stringify(baseline));
    });

    it('does not consult the clock or randomness', () => {
        const realNow = Date.now;
        const realRandom = Math.random;
        Date.now = () => { throw new Error('clock used'); };
        Math.random = () => { throw new Error('randomness used'); };
        try {
            expect(() => buildForecast(rows, TARGET, { events })).not.toThrow();
        } finally {
            Date.now = realNow;
            Math.random = realRandom;
        }
    });
});

describe('event context - confidence, range and interplay with other signals', () => {
    it('is less certain when an event\'s effect is only a declared guess, and more so once learned', () => {
        const plain = buildForecast(history(), TARGET);
        const declared = buildForecast(history(), TARGET, { events: [ev(TARGET, 'festival', 'Fair', 50)] });
        const days = ['2026-03-05', '2026-03-12', '2026-03-19', '2026-03-26'];
        const learned = buildForecast(history({ overrides: on(days, 150) }), TARGET, { events: [...pastEvents(days), ev(TARGET, 'festival', 'Fair')] });

        expect(declared.confidenceScore).toBeLessThan(plain.confidenceScore);
        expect(learned.confidenceScore).toBeGreaterThan(declared.confidenceScore);
        const width = (r) => (r.keyFactors.expected_range.high - r.keyFactors.expected_range.low) / r.keyFactors.central_estimate;
        expect(width(declared)).toBeGreaterThan(width(plain));
    });

    it('falls back safely with too little history, but still reports the target event', () => {
        const few = history({ days: 2 });
        const plain = buildForecast(few, TARGET);
        const result = buildForecast(few, TARGET, { events: [ev(TARGET, 'festival', 'Fair', 50)] });
        expect(result.modelVersion).toBe('heuristic_fallback_v1');
        expect(result.predictedQuantity).toBe(plain.predictedQuantity);
        expect(result.confidenceScore).toBe(0.3);
        expect(result.keyFactors.event_context).toMatchObject({ applied: false, target_events: [{ type: 'festival', name: 'Fair' }] });
        expect(plain.keyFactors).not.toHaveProperty('event_context');
    });

    it('keeps event days in the baseline when excluding them would leave too little history', () => {
        const rows = history({ days: 5, overrides: on(['2026-03-02', '2026-03-03', '2026-03-04'], 300) });
        const events = pastEvents(['2026-03-02', '2026-03-03', '2026-03-04']);
        const result = buildForecast(rows, TARGET, { events });
        expect(result.modelVersion).toBe('stat_context_v2');
        expect(result.keyFactors.data_points_used).toBe(5);
        expect(result.keyFactors.event_context).toMatchObject({ history_event_days_excluded: 0, exclusion_skipped_insufficient_baseline: true });
    });

    describe('with an attendance signal', () => {
        const target = '2026-03-03';
        const headcount = { base: 100, weekday: [0.5, 1.1, 1.1, 1.0, 1.0, 0.9, 0.6], cv: 0.15, perPerson: 0.9, perPersonCv: 0.03 };
        const rows = generateSeries({ seed: 31, days: 56, headcount });
        const events = [ev(target, 'festival', 'Fair', 50)];

        it('applies the event factor to the whole estimate when attendance is only inferred from history', () => {
            const plain = buildForecast(rows, target);
            const result = buildForecast(rows, target, { events });
            expect(result.keyFactors.event_context.adjustment.applied_to).toBe('full_estimate');
            expect(result.predictedQuantity / plain.predictedQuantity).toBeGreaterThan(1.4);
            expect(result.predictedQuantity / plain.predictedQuantity).toBeLessThan(1.6);
        });

        it('does not double count when the kitchen already supplied the day\'s expected headcount', () => {
            const plain = buildForecast(rows, target, { expectedHeadcount: 150 });
            const result = buildForecast(rows, target, { expectedHeadcount: 150, events });
            expect(result.keyFactors.event_context.adjustment.applied_to).toBe('demand_estimate_only');
            expect(result.predictedQuantity / plain.predictedQuantity).toBeLessThan(1.15);
            expect(result.keyFactors.reason).toMatch(/event factor was applied to the demand-history part only/);
        });
    });
});

describe('event types', () => {
    it('supports holiday, festival, exam, institutional event, special meal and closure', () => {
        expect([...EVENT_TYPES].sort()).toEqual(['closure', 'exam', 'festival', 'holiday', 'institutional_event', 'special_meal']);
    });

    it('accepts any of them as context', () => {
        EVENT_TYPES.forEach((type) => {
            const result = buildForecast(history(), TARGET, { events: [ev(TARGET, type, `A ${type}`, 10)] });
            expect(result.keyFactors.event_context.target_events[0].type).toBe(type);
            expect(result.keyFactors.event_context.adjustment.factor).toBeCloseTo(1.1, 3);
        });
    });
});
