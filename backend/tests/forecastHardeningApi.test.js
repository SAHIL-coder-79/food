const request = require('supertest');
const { app, pool, resetDb, registerKitchen } = require('./testHelpers');
const { buildForecast, MODEL_VERSION, FALLBACK_MODEL_VERSION } = require('../src/ai/forecastEngine');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const START = '2026-02-02'; // a Monday
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const TARGET = addDays(START, 24);
const SOLD_OUT_DAYS = [3, 7, 11, 15, 19, 23];

const demandAt = (i) => 100 + (((i * 7) % 5) - 2) * 2;

// One LUNCH log per day; days in soldOut sold out (everything prepared consumed, nothing left).
function makeRows(count, soldOut = []) {
    return Array.from({ length: count }, (_, i) => {
        const sells = soldOut.includes(i);
        const consumed = sells ? demandAt(i) * 0.9 : demandAt(i);
        const prepared = sells ? consumed : demandAt(i) * 1.2;
        return { log_date: addDays(START, i), quantity_prepared: prepared, quantity_leftover: prepared - consumed, quantity_consumed: consumed, consumed };
    });
}

async function createItem(token, name = 'Rice') {
    const res = await request(app).post('/api/menu-items').set(auth(token)).send({ name, unit: 'kg' });
    expect(res.status).toBe(201);
    return res.body.menuItem;
}

async function seedRows(itemId, rows, { createdAt = null } = {}) {
    for (const r of rows) {
        await pool.query(
            `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed, created_at)
             VALUES ($1, $2, 'LUNCH', $3, $4, $5, COALESCE($6::timestamptz, ($2::date + time '20:00')::timestamp))`,
            [itemId, r.log_date, r.quantity_prepared, r.quantity_leftover, r.quantity_consumed, createdAt]
        );
    }
}

const forecast = (token, itemId, date = TARGET) => request(app).get(`/api/forecasts/${itemId}?targetDate=${date}`).set(auth(token));
const evaluate = (token, body) => request(app).post('/api/prevention/evaluate').set(auth(token)).send(body);

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('forecast API keeps its contract and reports sold-out handling (hardening 1, 2, 4)', () => {
    it('returns exactly the four existing fields, with a clearly labelled range and uncalibrated confidence', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedRows(item.id, makeRows(24));

        const res = await forecast(kitchen.token, item.id);
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(Object.keys(data).sort()).toEqual(['confidenceScore', 'keyFactors', 'modelVersion', 'predictedQuantity']);
        expect(data.modelVersion).toBe(MODEL_VERSION);
        expect(typeof data.predictedQuantity).toBe('number');
        expect(data.keyFactors.expected_range).toMatchObject({ coverage: 0.8, basis: 'demand_before_safety_buffer' });
        expect(data.keyFactors.expected_range.low).toBeLessThanOrEqual(data.keyFactors.expected_range.high);
        expect(data.keyFactors.forecast_confidence).toMatchObject({ type: 'heuristic_reliability_score', calibrated: false });
        expect(data.keyFactors.demand_censoring).toMatchObject({ status: 'none_detected', sold_out_days: 0 });
    });

    it('corrects sold-out days end to end, exactly as the pure engine does on the same logs', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        const rows = makeRows(24, SOLD_OUT_DAYS);
        await seedRows(item.id, rows);

        const res = await forecast(kitchen.token, item.id);
        expect(res.status).toBe(200);
        expect(res.body.data.keyFactors.demand_censoring).toMatchObject({ status: 'adjusted', sold_out_days: 6, adjusted_days: 6 });
        expect(res.body.data.predictedQuantity).toBe(buildForecast(rows, TARGET).predictedQuantity);
        expect(res.body.data.predictedQuantity).toBeGreaterThan(buildForecast(rows, TARGET, { adjustForSoldOut: false }).predictedQuantity);
        expect(res.body.data.keyFactors.data_quality.stockout_days).toBe(6);
    });

    it('saves the same forecast (with the censoring explanation) that it returns', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedRows(item.id, makeRows(24, SOLD_OUT_DAYS));
        const res = await forecast(kitchen.token, item.id);
        const { rows } = await pool.query('SELECT predicted_quantity, confidence_score, model_version, key_factors FROM ai_forecasts WHERE menu_item_id = $1', [item.id]);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].predicted_quantity)).toBe(res.body.data.predictedQuantity);
        expect(rows[0].key_factors.demand_censoring.status).toBe('adjusted');
    });

    it('keeps the short-history fallback: same predictedQuantity, fixed 0.3, no range, still labelled uncalibrated', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedRows(item.id, makeRows(2, [0, 1]));
        const res = await forecast(kitchen.token, item.id);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(['confidenceScore', 'keyFactors', 'modelVersion', 'predictedQuantity']);
        expect(res.body.data.modelVersion).toBe(FALLBACK_MODEL_VERSION);
        expect(res.body.data.confidenceScore).toBe(0.3);
        expect(res.body.data.keyFactors.expected_range).toBeUndefined();
        expect(res.body.data.keyFactors.forecast_confidence).toMatchObject({ calibrated: false });
    });

    it("never lets another organization's sold-out logs influence a forecast", async () => {
        const kitchenA = await registerKitchen({ organizationName: 'Kitchen A' });
        const kitchenB = await registerKitchen({ organizationName: 'Kitchen B' });
        const itemA = await createItem(kitchenA.token);
        const itemB = await createItem(kitchenB.token);
        await seedRows(itemA.id, makeRows(24));
        const before = (await forecast(kitchenA.token, itemA.id)).body.data;
        await seedRows(itemB.id, makeRows(24, SOLD_OUT_DAYS).map((r) => ({ ...r, quantity_consumed: 9999, quantity_prepared: 9999, quantity_leftover: 0 })));
        const after = (await forecast(kitchenA.token, itemA.id)).body.data;
        expect(after.predictedQuantity).toBe(before.predictedQuantity);
        expect(after.keyFactors.demand_censoring).toEqual(before.keyFactors.demand_censoring);
    });
});

describe('prevention exposes the expected range and stays compatible (hardening 2)', () => {
    async function setup(rows) {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedRows(item.id, rows);
        return { kitchen, item };
    }

    it('keeps predictedQuantity and recommendedQuantity equal to the forecast endpoint, and adds the range', async () => {
        const { kitchen, item } = await setup(makeRows(24, SOLD_OUT_DAYS));
        const forecastData = (await forecast(kitchen.token, item.id)).body.data;
        const res = await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: forecastData.predictedQuantity });
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data.predictedQuantity).toBe(forecastData.predictedQuantity);
        expect(data.recommendedQuantity).toBe(forecastData.predictedQuantity);
        expect(data.plannedQuantity).toBe(forecastData.predictedQuantity);
        expect(data.excess).toBe(0);
        expect(data.riskLevel).toBe('LOW');
        expect(data.expectedRange).toEqual({
            low: forecastData.keyFactors.expected_range.low,
            high: forecastData.keyFactors.expected_range.high,
            coverage: 0.8,
            basis: 'demand_before_safety_buffer',
            safetyBufferPct: 5,
            note: expect.stringMatching(/not a guarantee/),
        });
        expect(data.confidenceType).toBe('heuristic_reliability_score');
        expect(data.evidence.expected_range).toEqual(forecastData.keyFactors.expected_range);
    });

    it('says where the plan sits against the range without changing the risk decision', async () => {
        const { kitchen, item } = await setup(makeRows(24));
        const { predictedQuantity, keyFactors } = (await forecast(kitchen.token, item.id)).body.data;
        const { low, high } = keyFactors.expected_range;

        const above = (await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: high * 1.5 })).body.data;
        expect(above.plannedVsExpectedRange).toBe('above_range');
        expect(above.riskLevel).toBe('HIGH');
        expect(above.excess).toBeCloseTo(high * 1.5 - predictedQuantity, 5);

        const within = (await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: (low + high) / 2 })).body.data;
        expect(within.plannedVsExpectedRange).toBe('within_range');

        const below = (await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: low / 2 })).body.data;
        expect(below.plannedVsExpectedRange).toBe('below_range');
        expect(below.riskLevel).toBe('LOW');
        expect(below.excess).toBe(0);
    });

    it('risk level still follows predictedQuantity (5% / 15% over), independent of the range', async () => {
        const { kitchen, item } = await setup(makeRows(24));
        const { predictedQuantity } = (await forecast(kitchen.token, item.id)).body.data;
        const risk = async (factor) => (await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: predictedQuantity * factor })).body.data.riskLevel;
        expect(await risk(1.0)).toBe('LOW');
        expect(await risk(1.1)).toBe('MEDIUM');
        expect(await risk(1.2)).toBe('HIGH');
    });

    it('gives no range (null) when there is too little history, and keeps the fallback quantity', async () => {
        const { kitchen, item } = await setup(makeRows(2));
        const res = await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: 50 });
        expect(res.status).toBe(200);
        expect(res.body.data.expectedRange).toBeNull();
        expect(res.body.data.plannedVsExpectedRange).toBeNull();
        expect(res.body.data.predictedQuantity).toBeGreaterThan(0);
        expect(res.body.data.evidence.forecast_confidence.calibrated).toBe(false);
    });

    it('stores the recommendation with the range inside its evidence, and still rejects other organizations', async () => {
        const { kitchen, item } = await setup(makeRows(24));
        const { predictedQuantity } = (await forecast(kitchen.token, item.id)).body.data;
        const res = await evaluate(kitchen.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: predictedQuantity * 1.5 });
        expect(res.body.data.recommendationId).toBeGreaterThan(0);
        const { rows } = await pool.query('SELECT supporting_evidence FROM ai_prevention_recommendations WHERE id = $1', [res.body.data.recommendationId]);
        expect(rows[0].supporting_evidence.expected_range.basis).toBe('demand_before_safety_buffer');

        const other = await registerKitchen({ organizationName: 'Other Kitchen' });
        expect((await evaluate(other.token, { menuItemId: item.id, targetDate: TARGET, plannedQuantity: 100 })).status).toBe(403);
        expect((await request(app).post('/api/prevention/evaluate').send({ menuItemId: item.id, targetDate: TARGET, plannedQuantity: 100 })).status).toBe(401);
    });
});

describe('forecast-vs-actual: point-in-time option (hardening 3)', () => {
    const PERFORMANCE = '/api/analytics/forecast-performance';
    const DAY_QUERY = `startDate=${TARGET}&endDate=${TARGET}`;
    const performance = (token, query = DAY_QUERY) => request(app).get(`${PERFORMANCE}?${query}`).set(auth(token));

    // History (before the target) is recorded that same evening, except where a test says otherwise.
    async function seedPeriod(itemId, { historyCreatedAt = null } = {}) {
        await seedRows(itemId, makeRows(24, SOLD_OUT_DAYS), { createdAt: historyCreatedAt });
        await pool.query(
            `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed, created_at)
             VALUES ($1, $2, 'LUNCH', 120, 15, 105, COALESCE($3::timestamptz, ($2::date + time '20:00')::timestamp))`,
            [itemId, TARGET, historyCreatedAt]
        );
    }

    it('rejects an invalid historyAsOf and requires authentication', async () => {
        const kitchen = await registerKitchen();
        expect((await performance(kitchen.token, `${DAY_QUERY}&historyAsOf=whenever`)).status).toBe(400);
        expect((await request(app).get(`${PERFORMANCE}?historyAsOf=recorded_at`)).status).toBe(401);
    });

    it('defaults to the log-date rule and explains the option', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedPeriod(item.id);
        const res = await performance(kitchen.token);
        expect(res.status).toBe(200);
        expect(res.body.data.meta.historyAsOf.mode).toBe('log_date');
        expect(res.body.data.records[0].forecast).toMatchObject({ source: 'reconstructed', lateRecordedLogsUsed: 0 });
        expect(res.body.data.records[0].actual.soldOut).toBe(false);
        expect(res.body.data.summary.reconstructedUsingLateLogs).toBe(0);
    });

    it('reconstructs the same forecast the live engine would give, sold-out correction included', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedPeriod(item.id);
        const res = await performance(kitchen.token);
        expect(res.body.data.records[0].forecast.predictedQuantity).toBe(buildForecast(makeRows(24, SOLD_OUT_DAYS), TARGET).predictedQuantity);
    });

    it('bulk-loaded history is still evaluated by default but reported as late-entered', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedPeriod(item.id, { historyCreatedAt: new Date().toISOString() }); // entered long after the target day
        const res = await performance(kitchen.token);
        expect(res.status).toBe(200);
        expect(res.body.data.records).toHaveLength(1);
        expect(res.body.data.records[0].forecast.lateRecordedLogsUsed).toBe(24);
        expect(res.body.data.summary.reconstructedUsingLateLogs).toBe(1);
    });

    it('strict mode refuses to reconstruct from logs that did not exist yet', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedPeriod(item.id, { historyCreatedAt: new Date().toISOString() });
        const res = await performance(kitchen.token, `${DAY_QUERY}&historyAsOf=recorded_at`);
        expect(res.status).toBe(200);
        expect(res.body.data.meta.historyAsOf.mode).toBe('recorded_at');
        expect(res.body.data.records).toHaveLength(0);
        expect(res.body.data.summary.skipped.insufficientHistory).toBe(1);
        expect(res.body.data.summary.reconstructedUsingLateLogs).toBe(0);
    });

    it('strict mode matches the default when history was recorded in time', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedPeriod(item.id);
        const normal = (await performance(kitchen.token)).body.data;
        const strict = (await performance(kitchen.token, `${DAY_QUERY}&historyAsOf=recorded_at`)).body.data;
        expect(strict.records[0].forecast).toEqual(normal.records[0].forecast);
    });

    it('flags a sold-out actual as a lower bound on demand', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedRows(item.id, makeRows(24, SOLD_OUT_DAYS));
        await pool.query(
            `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed)
             VALUES ($1, $2, 'LUNCH', 105, 0, 105)`,
            [item.id, TARGET]
        );
        const res = await performance(kitchen.token);
        expect(res.body.data.records[0].actual.soldOut).toBe(true);
        expect(res.body.data.meta.notes.join(' ')).toMatch(/lower bound on true demand/);
    });

    it("does not reconstruct from another organization's logs", async () => {
        const kitchenA = await registerKitchen({ organizationName: 'A' });
        const kitchenB = await registerKitchen({ organizationName: 'B' });
        const itemA = await createItem(kitchenA.token);
        const itemB = await createItem(kitchenB.token);
        await seedRows(itemB.id, makeRows(24, SOLD_OUT_DAYS));
        await pool.query(
            `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed)
             VALUES ($1, $2, 'LUNCH', 120, 15, 105)`,
            [itemA.id, TARGET]
        );
        const res = await performance(kitchenA.token);
        expect(res.body.data.records).toHaveLength(0); // A has one log only: nothing to reconstruct from
        expect(res.body.data.summary.skipped.insufficientHistory).toBe(1);
    });
});
