const { computeForecastPerformance } = require('../src/services/forecastPerformanceService');
const { buildForecast } = require('../src/ai/forecastEngine');

const TODAY = '2026-03-20';
const PERIOD = { startDate: '2026-03-01', endDate: '2026-03-31' };

let nextId = 1;
const at = (date, time) => new Date(`${date}T${time}:00Z`);

function log(itemId, date, { consumed = null, prepared = null, leftover = null, createdAt, name = `Item${itemId}`, unit = 'kg', slot = 'LUNCH' } = {}) {
    return {
        id: nextId++,
        menu_item_id: itemId,
        menu_item_name: name,
        menu_item_unit: unit,
        log_date: date,
        meal_slot: slot,
        quantity_planned: null,
        quantity_prepared: prepared,
        quantity_leftover: leftover,
        quantity_consumed: consumed,
        headcount: null,
        created_at: createdAt || at(date, '20:00'),
        consumed: prepared !== null ? prepared - (leftover || 0) : null,
    };
}

function forecast(itemId, date, predicted, { createdAt, id, name = `Item${itemId}`, unit = 'kg', keyFactors = null } = {}) {
    return {
        id: id ?? nextId++,
        menu_item_id: itemId,
        menu_item_name: name,
        menu_item_unit: unit,
        target_date: date,
        predicted_quantity: predicted,
        confidence_score: 0.8,
        model_version: 'stat_context_v2',
        key_factors: keyFactors,
        created_at: createdAt || at(date, '08:00'),
    };
}

const compute = (input, overrides = {}) => computeForecastPerformance({ period: PERIOD, today: TODAY, ...input, ...overrides });

// forecast + actual pair on `date`
function pair(itemId, date, predicted, actual, extra = {}) {
    return {
        logs: [log(itemId, date, { consumed: actual, ...(extra.log || {}) })],
        forecasts: [forecast(itemId, date, predicted, extra.forecast)],
    };
}
function merge(...parts) {
    return { logs: parts.flatMap((p) => p.logs || []), forecasts: parts.flatMap((p) => p.forecasts || []), recommendations: parts.flatMap((p) => p.recommendations || []) };
}

describe('forecast performance - exact match, overprediction, underprediction', () => {
    const data = merge(pair(1, '2026-03-04', 100, 100), pair(2, '2026-03-04', 120, 100), pair(3, '2026-03-04', 80, 100));
    const result = compute(data);
    const byItem = (id) => result.records.find((r) => r.menuItemId === id);

    it('scores an exact match as zero error', () => {
        expect(byItem(1).error).toEqual({ error: 0, absoluteError: 0, percentageError: 0, absolutePercentageError: 0, direction: 'exact' });
        expect(byItem(1).status).toBe('evaluated');
    });

    it('scores over-prediction with a positive error', () => {
        expect(byItem(2).error).toEqual({ error: 20, absoluteError: 20, percentageError: 20, absolutePercentageError: 20, direction: 'over' });
        expect(byItem(2).forecast.predictedQuantity).toBe(120);
        expect(byItem(2).actual.consumedQuantity).toBe(100);
    });

    it('scores under-prediction with a negative error', () => {
        expect(byItem(3).error).toEqual({ error: -20, absoluteError: 20, percentageError: -20, absolutePercentageError: 20, direction: 'under' });
    });

    it('summarises accuracy, error and bias across the evaluated forecasts', () => {
        expect(result.summary).toMatchObject({
            evaluatedCount: 3,
            totalPredicted: 300,
            totalActual: 300,
            mae: 13.33,
            mape: 13.3,
            wape: 13.3,
            bias: 0,
            biasPercentage: 0,
            accuracyPercentage: 86.7,
            overpredictedCount: 1,
            underpredictedCount: 1,
            exactCount: 1,
            pendingCount: 0,
            missingActualCount: 0,
        });
    });

    it('treats sub-decimal differences as exact and keeps percentage errors undefined for zero actuals', () => {
        const exact = compute(pair(1, '2026-03-04', 100.04, 100));
        expect(exact.records[0].error.direction).toBe('exact');

        const zero = compute(pair(1, '2026-03-04', 10, 0));
        expect(zero.records[0].error).toMatchObject({ error: 10, percentageError: null, absolutePercentageError: null, direction: 'over' });
        expect(zero.summary.wape).toBeNull();
        expect(zero.summary.accuracyPercentage).toBeNull();
        expect(zero.summary.mape).toBeNull();
    });

    it('never reports negative accuracy', () => {
        const wild = compute(pair(1, '2026-03-04', 1000, 10));
        expect(wild.summary.accuracyPercentage).toBe(0);
    });
});

describe('forecast performance - what counts as the actual', () => {
    it('prefers the logged consumed quantity, else prepared minus leftover', () => {
        const logged = compute({ logs: [log(1, '2026-03-04', { consumed: 70, prepared: 100, leftover: 10 })], forecasts: [forecast(1, '2026-03-04', 70)] });
        expect(logged.records[0].actual).toMatchObject({ consumedQuantity: 70, preparedQuantity: 100, leftoverQuantity: 10 });

        const derived = compute({ logs: [log(1, '2026-03-04', { prepared: 100, leftover: 10 })], forecasts: [forecast(1, '2026-03-04', 90)] });
        expect(derived.records[0].actual.consumedQuantity).toBe(90);
    });

    it('averages multiple meal-slot logs on one day, like the forecast engine', () => {
        const logs = [log(1, '2026-03-04', { consumed: 100, slot: 'LUNCH' }), log(1, '2026-03-04', { consumed: 60, slot: 'DINNER' })];
        const result = compute({ logs, forecasts: [forecast(1, '2026-03-04', 80)] });
        expect(result.records[0].actual).toMatchObject({ consumedQuantity: 80, logCount: 2 });
        expect(result.records[0].error.direction).toBe('exact');
    });

    it('treats a log with no usable quantities as no actual', () => {
        const result = compute({ logs: [log(1, '2026-03-04', {})], forecasts: [forecast(1, '2026-03-04', 80)] });
        expect(result.summary.evaluatedCount).toBe(0);
        expect(result.records[0].status).toBe('missing_actual');
    });

    it('only compares actuals inside the requested period', () => {
        const result = compute(pair(1, '2026-02-20', 100, 100));
        expect(result.summary.evaluatedCount).toBe(0);
        expect(result.records).toEqual([]);
    });
});

describe('forecast performance - missing actual', () => {
    const forecasts = [
        forecast(1, '2026-03-10', 100), // past, never logged
        forecast(1, '2026-03-20', 100), // today
        forecast(1, '2026-03-25', 100), // future
    ];
    const result = compute({ logs: [], forecasts });

    it('flags past forecasts without an actual as missing and today/future as awaiting', () => {
        const status = Object.fromEntries(result.records.map((r) => [r.targetDate, r.status]));
        expect(status).toEqual({ '2026-03-10': 'missing_actual', '2026-03-20': 'awaiting_actual', '2026-03-25': 'awaiting_actual' });
    });

    it('never invents an error for them and leaves them out of the metrics', () => {
        result.records.forEach((r) => {
            expect(r.actual).toBeNull();
            expect(r.error).toBeNull();
        });
        expect(result.summary).toMatchObject({ evaluatedCount: 0, missingActualCount: 1, pendingCount: 2, mae: null, accuracyPercentage: null });
    });

    it('explains the gap in plain words', () => {
        expect(result.insights.map((i) => i.type)).toEqual(['no_evaluated_forecasts', 'missing_actuals']);
        expect(result.insights[1].message).toBe('1 past forecast(s) have no actual daily log, so they could not be evaluated.');
    });

    it('collapses repeated forecasts for one item-day into a single record', () => {
        const dup = compute({ logs: [], forecasts: [forecast(1, '2026-03-10', 90, { createdAt: at('2026-03-09', '08:00') }), forecast(1, '2026-03-10', 95, { createdAt: at('2026-03-09', '18:00') })] });
        expect(dup.records).toHaveLength(1);
        expect(dup.records[0].forecast.predictedQuantity).toBe(95);
    });
});

describe('forecast performance - which forecast counts (prospective vs after the outcome)', () => {
    const date = '2026-03-04';
    const actualLog = log(1, date, { consumed: 100, createdAt: at(date, '20:00') });

    it('uses the latest forecast created before the outcome was recorded', () => {
        const result = compute({
            logs: [actualLog],
            forecasts: [
                forecast(1, date, 90, { createdAt: at(date, '08:00') }),
                forecast(1, date, 110, { createdAt: at(date, '15:00') }),
                forecast(1, date, 100, { createdAt: at('2026-03-05', '09:00') }), // created AFTER the outcome
            ],
        });
        expect(result.records[0].forecast).toMatchObject({ source: 'stored', predictedQuantity: 110 });
        expect(result.records[0].error.direction).toBe('over');
    });

    it('does not treat a forecast created after the outcome as prospective (stored-only mode skips it)', () => {
        const cheat = forecast(1, date, 100, { createdAt: at('2026-03-05', '09:00') });
        const result = compute({ logs: [actualLog], forecasts: [cheat] }, { source: 'stored' });
        expect(result.summary.evaluatedCount).toBe(0);
        expect(result.summary.skipped.storedAfterOutcome).toBe(1);
        expect(result.records).toEqual([]);
    });

    it('accepts a forecast created at the very instant the outcome was recorded', () => {
        const result = compute({ logs: [actualLog], forecasts: [forecast(1, date, 100, { createdAt: at(date, '20:00') })] });
        expect(result.records[0].forecast.source).toBe('stored');
    });

    it('uses the earliest of several same-day logs as the moment the outcome became known', () => {
        const logs = [
            log(1, date, { consumed: 100, slot: 'LUNCH', createdAt: at(date, '13:00') }),
            log(1, date, { consumed: 100, slot: 'DINNER', createdAt: at(date, '21:00') }),
        ];
        const result = compute({ logs, forecasts: [forecast(1, date, 100, { createdAt: at(date, '15:00') })] }, { source: 'stored' });
        expect(result.summary.evaluatedCount).toBe(0); // forecast came after the lunch outcome was known
    });
});

describe('forecast performance - historical leakage', () => {
    // 14 days at 100, then a 500 outlier on the target day, then even bigger values afterwards.
    const history = Array.from({ length: 14 }, (_, i) => log(1, `2026-02-${String(10 + i).padStart(2, '0')}`, { consumed: 100 }));
    const target = '2026-02-24';
    const outcome = log(1, target, { consumed: 500 });
    const isoPlus = (start, days) => new Date(Date.parse(`${start}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    const later = Array.from({ length: 8 }, (_, i) => log(1, isoPlus('2026-02-25', i), { consumed: 900 }));
    const period = { startDate: target, endDate: target };

    it('reconstructs a historical forecast from logs dated strictly before the target date', () => {
        const result = compute({ logs: [...history, outcome, ...later] }, { period });
        const record = result.records[0];
        expect(record.forecast.source).toBe('reconstructed');
        expect(record.forecast.predictedQuantity).toBe(105); // 100 + 5% buffer: the 500 outcome and later logs are ignored
        expect(record.actual.consumedQuantity).toBe(500);
        expect(record.error.direction).toBe('under');
    });

    it('gives the same reconstructed forecast with or without any later logs', () => {
        const withFuture = compute({ logs: [...history, outcome, ...later] }, { period }).records[0].forecast;
        const withoutFuture = compute({ logs: [...history, outcome] }, { period }).records[0].forecast;
        const withoutOutcome = buildForecast(history, target);
        expect(withFuture).toEqual(withoutFuture);
        expect(withFuture.predictedQuantity).toBe(withoutOutcome.predictedQuantity);
        expect(withFuture.confidenceScore).toBe(withoutOutcome.confidenceScore);
    });

    it('does not let a "perfect" forecast saved after the outcome replace the reconstruction', () => {
        const cheat = forecast(1, target, 500, { createdAt: at('2026-02-26', '09:00') });
        const result = compute({ logs: [...history, outcome], forecasts: [cheat] }, { period });
        expect(result.records[0].forecast).toMatchObject({ source: 'reconstructed', predictedQuantity: 105 });
        expect(result.summary.bySource.reconstructed.evaluatedCount).toBe(1);
        expect(result.summary.bySource.stored.evaluatedCount).toBe(0);
    });

    it('does not reconstruct forecasts with fewer than 3 days of earlier history', () => {
        const early = [log(1, '2026-02-10', { consumed: 100 }), log(1, '2026-02-11', { consumed: 100 })];
        const result = compute({ logs: early }, { period: { startDate: '2026-02-10', endDate: '2026-02-11' } });
        expect(result.summary.evaluatedCount).toBe(0);
        expect(result.summary.skipped.insufficientHistory).toBe(2);
    });

    it('reconstructs day by day using only what was known on each day', () => {
        const rising = Array.from({ length: 12 }, (_, i) => log(1, `2026-02-${String(10 + i).padStart(2, '0')}`, { consumed: 100 + i * 10 }));
        const result = compute({ logs: rising }, { period: { startDate: '2026-02-10', endDate: '2026-02-21' } });
        result.records.forEach((r) => {
            const known = rising.filter((l) => l.log_date < r.targetDate);
            expect(r.forecast.predictedQuantity).toBe(buildForecast(known, r.targetDate).predictedQuantity);
        });
    });

    it('skips reconstruction entirely in stored-only mode', () => {
        const result = compute({ logs: [...history, outcome] }, { period, source: 'stored' });
        expect(result.summary.evaluatedCount).toBe(0);
    });
});

describe('forecast performance - accuracy over time', () => {
    const dates = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12'];
    const series = (predictions) => merge(...dates.map((d, i) => pair(1, d, predictions[i], 100)));

    it('reports an improving trend when recent forecasts are more accurate', () => {
        const { trend } = compute(series([130, 130, 130, 130, 102, 102, 102, 102]));
        expect(trend).toEqual({ direction: 'improving', minimumRecords: 6, evaluatedCount: 8, olderWape: 30, newerWape: 2, changePoints: -28 });
    });

    it('reports a worsening trend when recent forecasts are less accurate', () => {
        const { trend } = compute(series([101, 101, 101, 101, 125, 125, 125, 125]));
        expect(trend.direction).toBe('worsening');
        expect(trend.changePoints).toBe(24);
    });

    it('reports a stable trend when error barely changes', () => {
        const { trend } = compute(series([110, 110, 110, 110, 111, 111, 111, 111]));
        expect(trend.direction).toBe('stable');
    });

    it('needs enough evaluated forecasts before claiming a trend', () => {
        const { trend } = compute(merge(...dates.slice(0, 5).map((d) => pair(1, d, 130, 100))));
        expect(trend).toMatchObject({ direction: 'insufficient_data', evaluatedCount: 5, olderWape: null, newerWape: null });
    });

    it('groups accuracy by week (Monday start), oldest first', () => {
        const { weekly } = compute(series([130, 130, 130, 130, 102, 102, 102, 102]));
        expect(weekly).toEqual([
            { weekStart: '2026-03-02', evaluatedCount: 4, mae: 30, wape: 30, accuracyPercentage: 70 },
            { weekStart: '2026-03-09', evaluatedCount: 4, mae: 2, wape: 2, accuracyPercentage: 98 },
        ]);
    });

    it('mentions the trend in the insights', () => {
        const { insights } = compute(series([130, 130, 130, 130, 102, 102, 102, 102]));
        expect(insights.find((i) => i.type === 'trend_improving').message).toBe('Forecast error is improving: 30% earlier vs 2% in the most recent half.');
    });
});

describe('forecast performance - per item, range hit rate and insights', () => {
    it('breaks accuracy down by menu item and names the hardest one', () => {
        const parts = [];
        ['2026-03-02', '2026-03-03', '2026-03-04'].forEach((d) => {
            parts.push(pair(1, d, 100, 100, { log: { name: 'Rice' }, forecast: { name: 'Rice' } }));
            parts.push(pair(2, d, 150, 100, { log: { name: 'Dal' }, forecast: { name: 'Dal' } }));
        });
        const result = compute(merge(...parts));
        expect(result.byMenuItem.map((i) => [i.name, i.evaluatedCount, i.wape, i.biasPercentage])).toEqual([
            ['Dal', 3, 50, 50],
            ['Rice', 3, 0, 0],
        ]);
        expect(result.insights.find((i) => i.type === 'hardest_item').message).toBe('Dal is the hardest to forecast (50% error over 3 days).');
        expect(result.insights.find((i) => i.type === 'bias_over').message).toMatch(/over-predict by about 25%/);
    });

    it('measures how often the actual fell inside the forecast\'s own expected range', () => {
        const range = { expected_range: { low: 90, high: 110 } };
        const result = compute(
            merge(
                pair(1, '2026-03-02', 100, 100, { forecast: { keyFactors: range } }),
                pair(1, '2026-03-03', 100, 150, { forecast: { keyFactors: range } }),
                pair(1, '2026-03-04', 100, 100)
            )
        );
        expect(result.summary.rangeHitRate).toBe(50); // the forecast without a range is not counted
    });
});

describe('forecast performance - intervention linkage', () => {
    const date = '2026-03-04';
    const rec = (id, overrides = {}) => ({
        id,
        menu_item_id: 1,
        menu_item_name: 'Rice',
        menu_item_unit: 'kg',
        target_date: date,
        status: 'approved',
        risk_level: 'HIGH',
        recommended_quantity: 100,
        estimated_excess: 30,
        created_at: at('2026-03-03', '10:00'),
        effectiveness_score: null,
        evaluated_at: null,
        ...overrides,
    });

    const baseLogs = [log(1, date, { prepared: 100, leftover: 5, name: 'Rice' })]; // consumed 95
    const forecasts = [
        forecast(1, date, 100, { id: 501, createdAt: at('2026-03-03', '09:59'), name: 'Rice' }), // basis: made just before the recommendation
        forecast(1, date, 200, { id: 502, createdAt: at('2026-03-03', '11:00'), name: 'Rice' }), // made after it
    ];

    it('links a recommendation to the forecast it was based on, the actual outcome and the learning score', () => {
        const result = compute({ logs: baseLogs, forecasts, recommendations: [rec(1, { effectiveness_score: 1, evaluated_at: at(date, '22:00') })] });
        const item = result.interventions.items[0];

        expect(item).toMatchObject({
            recommendationId: 1,
            menuItemName: 'Rice',
            targetDate: date,
            managerAction: 'approved',
            riskLevel: 'HIGH',
            recommendedQuantity: 100,
            estimatedExcess: 30,
            originalPlannedQuantity: 130,
        });
        expect(item.forecast).toEqual({ linked: true, forecastId: 501, predictedQuantity: 100, confidenceScore: 0.8, modelVersion: 'stat_context_v2' });
        expect(item.actual).toEqual({ preparedQuantity: 100, consumedQuantity: 95, leftoverQuantity: 5 });
        expect(item.forecastError).toMatchObject({ error: 5, direction: 'over' });
        expect(item.outcome).toEqual({ evaluated: true, effectivenessScore: 1, evaluatedAt: at(date, '22:00').toISOString() });
    });

    it('marks a decided recommendation as pending evaluation when the Learning score has not been computed yet', () => {
        const { interventions } = compute({ logs: baseLogs, forecasts, recommendations: [rec(2, { status: 'rejected' })] });
        expect(interventions.items[0].outcome).toEqual({ evaluated: false, effectivenessScore: null, evaluatedAt: null });
        expect(interventions.summary.pendingEvaluationCount).toBe(1);
    });

    it('marks recommendations without an actual log as awaiting the actual', () => {
        const { interventions } = compute({ logs: [], forecasts, recommendations: [rec(3)] });
        expect(interventions.items[0].actual).toBeNull();
        expect(interventions.items[0].forecastError).toBeNull();
        expect(interventions.summary.awaitingActualCount).toBe(1);
    });

    it('reports an unlinked forecast rather than guessing when none preceded the recommendation', () => {
        const late = [forecast(1, date, 100, { id: 601, createdAt: at('2026-03-03', '12:00') })];
        const { interventions } = compute({ logs: baseLogs, forecasts: late, recommendations: [rec(4)] });
        expect(interventions.items[0].forecast).toEqual({ linked: false });
    });

    it('summarises effectiveness overall and by manager decision', () => {
        const recs = [
            rec(1, { effectiveness_score: 1, evaluated_at: at(date, '22:00') }),
            rec(2, { status: 'rejected', effectiveness_score: -1, evaluated_at: at(date, '22:00') }),
            rec(3, { effectiveness_score: 0.5, evaluated_at: at(date, '22:00') }),
            rec(4, { status: 'rejected' }),
        ];
        const { summary } = compute({ logs: baseLogs, forecasts, recommendations: recs }).interventions;
        expect(summary).toEqual({
            decidedCount: 4,
            evaluatedCount: 3,
            pendingEvaluationCount: 1,
            awaitingActualCount: 0,
            averageEffectivenessScore: 0.17,
            positiveOutcomeShare: 66.7,
            approved: { decidedCount: 2, evaluatedCount: 2, averageEffectivenessScore: 0.75 },
            rejected: { decidedCount: 2, evaluatedCount: 1, averageEffectivenessScore: -1 },
        });
    });

    it('ignores recommendations outside the requested period', () => {
        const { interventions } = compute({ logs: baseLogs, forecasts, recommendations: [rec(5, { target_date: '2026-04-15' })] });
        expect(interventions.items).toEqual([]);
        expect(interventions.summary.decidedCount).toBe(0);
    });

    it('does not require a stored forecast to evaluate the loop', () => {
        const { interventions, summary } = compute({ logs: baseLogs, forecasts: [], recommendations: [rec(6)] });
        expect(interventions.items[0].forecast.linked).toBe(false);
        expect(summary.evaluatedCount).toBe(0);
    });
});

describe('forecast performance - determinism and shape', () => {
    const data = merge(
        pair(1, '2026-03-02', 110, 100),
        pair(1, '2026-03-03', 95, 100),
        pair(2, '2026-03-03', 60, 50),
        { forecasts: [forecast(2, '2026-03-12', 55)] },
        { recommendations: [{ id: 1, menu_item_id: 1, menu_item_name: 'Item1', menu_item_unit: 'kg', target_date: '2026-03-02', status: 'approved', risk_level: 'MEDIUM', recommended_quantity: 100, estimated_excess: 10, created_at: at('2026-03-02', '07:00'), effectiveness_score: 0.9, evaluated_at: at('2026-03-02', '22:00') }] }
    );

    const shuffle = (list) => list.slice().reverse();

    it('returns identical output for identical input, in any row order', () => {
        const baseline = compute(data);
        expect(compute(data)).toEqual(baseline);
        expect(compute({ logs: shuffle(data.logs), forecasts: shuffle(data.forecasts), recommendations: data.recommendations })).toEqual(baseline);
        expect(JSON.stringify(compute(data))).toBe(JSON.stringify(baseline));
    });

    it('has the documented shape and no internal database fields', () => {
        const result = compute(data);
        expect(Object.keys(result).sort()).toEqual(['byMenuItem', 'insights', 'interventions', 'meta', 'period', 'records', 'recordsTruncated', 'source', 'summary', 'trend', 'weekly']);
        const serialised = JSON.stringify(result);
        ['kitchen_org_id', 'key_factors', 'created_by', 'organization_id'].forEach((internal) => expect(serialised).not.toContain(internal));
    });

    it('returns a fully shaped empty result when there is nothing to compare', () => {
        const result = compute({});
        expect(result.summary).toMatchObject({ evaluatedCount: 0, pendingCount: 0, missingActualCount: 0, mae: null, wape: null, accuracyPercentage: null });
        expect(result.records).toEqual([]);
        expect(result.weekly).toEqual([]);
        expect(result.byMenuItem).toEqual([]);
        expect(result.trend.direction).toBe('insufficient_data');
        expect(result.interventions.items).toEqual([]);
        expect(result.insights[0].type).toBe('no_evaluated_forecasts');
    });

    it('caps the returned records but not the metrics', () => {
        const parts = Array.from({ length: 105 }, (_, i) => {
            const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
            return pair(1, date, 110, 100);
        });
        const result = compute(merge(...parts), { period: { startDate: '2026-01-01', endDate: '2026-12-31' } });
        expect(result.summary.evaluatedCount).toBe(105);
        expect(result.records).toHaveLength(100);
        expect(result.recordsTruncated).toBe(true);
        expect(result.records[0].targetDate > result.records[99].targetDate).toBe(true); // most recent first
    });
});
