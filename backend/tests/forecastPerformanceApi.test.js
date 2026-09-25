const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin } = require('./testHelpers');

const URL = '/api/analytics/forecast-performance';
const RANGE = 'startDate=2026-02-01&endDate=2099-12-31';
const TARGET = '2026-02-24';
const DAY_RANGE = `startDate=${TARGET}&endDate=${TARGET}`; // only the target day (seeded history days are actuals too)
const HISTORY_START = '2026-02-10'; // 14 days: Feb 10 .. Feb 23

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const performance = (token, query = DAY_RANGE) => request(app).get(`${URL}?${query}`).set(auth(token));

async function createItem(token, name = 'Rice') {
    const res = await request(app).post('/api/menu-items').set(auth(token)).send({ name, unit: 'kg' });
    expect(res.status).toBe(201);
    return res.body.menuItem;
}

// Direct SQL keeps the fixtures fast; created_at defaults to now().
async function seedHistory(itemId, start, days, consumed) {
    await pool.query(
        `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed)
         SELECT $1, ($2::date + g), 'LUNCH', $3::float + 20, 20, $3::float FROM generate_series(0, $4::int - 1) g`,
        [itemId, start, consumed, days]
    );
}

async function insertActual(itemId, date, { consumed, prepared, leftover }) {
    await pool.query(
        `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed)
         VALUES ($1, $2, 'LUNCH', $3, $4, $5)`,
        [itemId, date, prepared ?? consumed, leftover ?? 0, consumed ?? null]
    );
}

const requestForecast = (token, itemId, date) => request(app).get(`/api/forecasts/${itemId}?targetDate=${date}`).set(auth(token));

function collectKeys(value, out = new Set()) {
    if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
    else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([k, v]) => {
            out.add(k);
            collectKeys(v, out);
        });
    }
    return out;
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('GET /api/analytics/forecast-performance - authentication and validation', () => {
    it('rejects a request with no token', async () => {
        expect((await request(app).get(URL)).status).toBe(401);
    });

    it('rejects an invalid token', async () => {
        expect((await request(app).get(URL).set('Authorization', 'Bearer not-a-real-jwt')).status).toBe(401);
    });

    it('rejects a deactivated user', async () => {
        const kitchen = await registerKitchen();
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);
        expect((await performance(kitchen.token)).status).toBe(401);
    });

    it('rejects NGO roles and system admins (kitchen analytics only)', async () => {
        const ngo = await registerNgo();
        expect((await performance(ngo.token)).status).toBe(403);
        const { token } = await createSystemAdmin();
        expect((await performance(token)).status).toBe(403);
    });

    it.each([
        ['startDate=yesterday'],
        ['endDate=2026-13-45'],
        ['startDate=2026-02-30'],
        ['startDate=2026-03-05&endDate=2026-03-01'],
        ['menuItemId=abc'],
        ['menuItemId=0'],
        ['source=everything'],
        ['startDate=2099-01-01'], // after the default end date (today)
    ])('rejects invalid query %s with 400', async (query) => {
        const kitchen = await registerKitchen();
        expect((await performance(kitchen.token, query)).status).toBe(400);
    });
});

describe('GET /api/analytics/forecast-performance - empty organization', () => {
    it('returns a consistent, fully shaped empty result and reports the defaulted window', async () => {
        const kitchen = await registerKitchen();
        const res = await performance(kitchen.token, '');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');

        const { data } = res.body;
        expect(Object.keys(data).sort()).toEqual(['byMenuItem', 'insights', 'interventions', 'meta', 'period', 'records', 'recordsTruncated', 'source', 'summary', 'trend', 'weekly']);
        expect(data.summary).toMatchObject({ evaluatedCount: 0, pendingCount: 0, missingActualCount: 0, mae: null, accuracyPercentage: null });
        expect(data.records).toEqual([]);
        expect(data.trend.direction).toBe('insufficient_data');
        expect(data.interventions.items).toEqual([]);
        expect(data.period.defaulted).toBe(true);

        const start = new Date(`${data.period.startDate}T00:00:00Z`);
        const end = new Date(`${data.period.endDate}T00:00:00Z`);
        expect((end - start) / 86400000).toBe(89); // 90-day default window
    });
});

describe('GET /api/analytics/forecast-performance - forecast vs actual through the real endpoints', () => {
    async function scenario(token) {
        const exact = await createItem(token, 'ExactDish');
        const over = await createItem(token, 'OverDish');
        const under = await createItem(token, 'UnderDish');
        for (const item of [exact, over, under]) {
            await seedHistory(item.id, HISTORY_START, 14, 100);
            const res = await requestForecast(token, item.id, TARGET);
            expect(res.status).toBe(200);
            expect(res.body.data.predictedQuantity).toBe(105); // flat 100 + 5% buffer
        }
        // outcomes are recorded AFTER the forecasts were saved
        await insertActual(exact.id, TARGET, { consumed: 105 });
        await insertActual(over.id, TARGET, { consumed: 90 });
        await insertActual(under.id, TARGET, { consumed: 130 });
        return { exact, over, under };
    }

    it('scores exact, over-predicted and under-predicted forecasts against actual consumption', async () => {
        const kitchen = await registerKitchen();
        await scenario(kitchen.token);

        const { data } = (await performance(kitchen.token)).body;
        const byName = Object.fromEntries(data.records.map((r) => [r.menuItemName, r]));

        expect(byName.ExactDish.error).toEqual({ error: 0, absoluteError: 0, percentageError: 0, absolutePercentageError: 0, direction: 'exact' });
        expect(byName.OverDish.error).toEqual({ error: 15, absoluteError: 15, percentageError: 16.7, absolutePercentageError: 16.7, direction: 'over' });
        expect(byName.UnderDish.error).toEqual({ error: -25, absoluteError: 25, percentageError: -19.2, absolutePercentageError: 19.2, direction: 'under' });

        Object.values(byName).forEach((record) => {
            expect(record.status).toBe('evaluated');
            expect(record.forecast).toMatchObject({ source: 'stored', predictedQuantity: 105, modelVersion: 'stat_context_v2' });
            expect(record.forecast.createdAt).toEqual(expect.any(String));
        });
        expect(data.summary).toMatchObject({ evaluatedCount: 3, overpredictedCount: 1, underpredictedCount: 1, exactCount: 1, totalPredicted: 315, totalActual: 325 });
        expect(data.summary.bySource.stored.evaluatedCount).toBe(3);
        expect(data.summary.bySource.reconstructed.evaluatedCount).toBe(0);
        expect(data.byMenuItem).toHaveLength(3);
    });

    it('filters to one menu item', async () => {
        const kitchen = await registerKitchen();
        const { over } = await scenario(kitchen.token);
        const { data } = (await performance(kitchen.token, `${DAY_RANGE}&menuItemId=${over.id}`)).body;
        expect(data.records.map((r) => r.menuItemName)).toEqual(['OverDish']);
        expect(data.summary.evaluatedCount).toBe(1);
    });

    it('reports past forecasts without an actual as missing and future ones as awaiting, never with an error', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedHistory(item.id, HISTORY_START, 14, 100);
        await requestForecast(kitchen.token, item.id, TARGET); // never logged
        await requestForecast(kitchen.token, item.id, '2099-01-01'); // far in the future

        const { data } = (await performance(kitchen.token, RANGE)).body;
        const status = Object.fromEntries(data.records.filter((r) => r.forecast.source === 'stored').map((r) => [r.targetDate, r.status]));
        expect(status).toEqual({ '2099-01-01': 'awaiting_actual', [TARGET]: 'missing_actual' });
        data.records.filter((r) => r.status !== 'evaluated').forEach((r) => {
            expect(r.actual).toBeNull();
            expect(r.error).toBeNull();
        });
        expect(data.summary.missingActualCount).toBe(1);
        expect(data.summary.pendingCount).toBe(1);
    });

    it('reconstructs forecasts (clearly labelled) for days that have an actual but no saved forecast', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedHistory(item.id, HISTORY_START, 14, 100);
        await insertActual(item.id, TARGET, { consumed: 100 });

        const { data } = (await performance(kitchen.token)).body;
        const record = data.records.find((r) => r.targetDate === TARGET);
        expect(record.forecast).toMatchObject({ source: 'reconstructed', predictedQuantity: 105, createdAt: null });
        expect(record.error.direction).toBe('over');
        expect(data.summary.bySource.reconstructed.evaluatedCount).toBe(1);

        const storedOnly = (await performance(kitchen.token, `${DAY_RANGE}&source=stored`)).body.data;
        expect(storedOnly.summary.evaluatedCount).toBe(0);
    });
});

describe('GET /api/analytics/forecast-performance - no future data in historical results', () => {
    async function pollutedHistory(token) {
        const item = await createItem(token, 'LeakDish');
        await seedHistory(item.id, HISTORY_START, 14, 100); // Feb 10 .. Feb 23 at 100
        await insertActual(item.id, TARGET, { consumed: 500 }); // the outcome, a big outlier
        await seedHistory(item.id, '2026-02-25', 8, 900); // even bigger logs AFTER the target date
        return item;
    }

    it('reconstructs a past day from earlier logs only, ignoring its own outcome and every later log', async () => {
        const kitchen = await registerKitchen();
        await pollutedHistory(kitchen.token);

        const { data } = (await performance(kitchen.token, 'startDate=2026-02-24&endDate=2026-03-04')).body;
        const record = data.records.find((r) => r.targetDate === TARGET);
        expect(record.forecast).toMatchObject({ source: 'reconstructed', predictedQuantity: 105 });
        expect(record.actual.consumedQuantity).toBe(500);
        expect(record.error.direction).toBe('under');
    });

    it('does not treat a forecast saved after the outcome was recorded as a real prospective forecast', async () => {
        const kitchen = await registerKitchen();
        const item = await pollutedHistory(kitchen.token);
        const retro = await requestForecast(kitchen.token, item.id, TARGET); // requested only now, after the outcome exists
        expect(retro.body.data.predictedQuantity).toBe(105); // the engine itself never reads the target day or later

        const stored = (await performance(kitchen.token, `startDate=${TARGET}&endDate=${TARGET}&source=stored`)).body.data;
        expect(stored.summary.evaluatedCount).toBe(0);
        expect(stored.summary.skipped.storedAfterOutcome).toBe(1);

        const all = (await performance(kitchen.token, `startDate=${TARGET}&endDate=${TARGET}`)).body.data;
        expect(all.records[0].forecast.source).toBe('reconstructed');
        expect(all.summary.bySource.stored.evaluatedCount).toBe(0);
    });

    it('is deterministic for repeated requests', async () => {
        const kitchen = await registerKitchen();
        await pollutedHistory(kitchen.token);
        const first = (await performance(kitchen.token, 'startDate=2026-02-24&endDate=2026-03-04')).body.data;
        const second = (await performance(kitchen.token, 'startDate=2026-02-24&endDate=2026-03-04')).body.data;
        expect(second).toEqual(first);
    });
});

describe('GET /api/analytics/forecast-performance - organization isolation', () => {
    it("never shows another organization's forecasts, actuals, items or interventions", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const itemA = await createItem(kitchenA.token, 'SecretRiceA');
        await seedHistory(itemA.id, HISTORY_START, 14, 100);
        await requestForecast(kitchenA.token, itemA.id, TARGET);
        await insertActual(itemA.id, TARGET, { consumed: 100 });

        const itemB = await createItem(kitchenB.token, 'PlainDalB');
        await seedHistory(itemB.id, HISTORY_START, 14, 50);
        await requestForecast(kitchenB.token, itemB.id, TARGET);
        await insertActual(itemB.id, TARGET, { consumed: 50 });

        const resB = await performance(kitchenB.token);
        expect(resB.status).toBe(200);
        expect(resB.body.data.records.map((r) => r.menuItemName)).toEqual(['PlainDalB']);
        expect(resB.body.data.byMenuItem.map((i) => i.name)).toEqual(['PlainDalB']);
        expect(JSON.stringify(resB.body)).not.toContain('SecretRiceA');

        const resA = await performance(kitchenA.token);
        expect(resA.body.data.records.map((r) => r.menuItemName)).toEqual(['SecretRiceA']);
        expect(JSON.stringify(resA.body)).not.toContain('PlainDalB');
    });

    it("blocks filtering by another organization's menu item, and 404s on unknown items", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const itemA = await createItem(kitchenA.token);

        expect((await performance(kitchenB.token, `${RANGE}&menuItemId=${itemA.id}`)).status).toBe(403);
        expect((await performance(kitchenB.token, `${RANGE}&menuItemId=999999`)).status).toBe(404);
        expect((await performance(kitchenA.token, `${RANGE}&menuItemId=${itemA.id}`)).status).toBe(200);
    });

    it('ignores client-supplied organization identifiers', async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const itemA = await createItem(kitchenA.token, 'SecretRiceA');
        await seedHistory(itemA.id, HISTORY_START, 14, 100);
        await requestForecast(kitchenA.token, itemA.id, TARGET);
        await insertActual(itemA.id, TARGET, { consumed: 100 });

        const spoofed = await performance(kitchenB.token, `${RANGE}&organizationId=${kitchenA.organization.id}&kitchenOrgId=${kitchenA.organization.id}`);
        expect(spoofed.status).toBe(200);
        expect(spoofed.body.data.summary.evaluatedCount).toBe(0);
        expect(JSON.stringify(spoofed.body)).not.toContain('SecretRiceA');

        const header = await request(app).get(`${URL}?${RANGE}`).set(auth(kitchenB.token)).set('x-organization-id', String(kitchenA.organization.id));
        expect(header.body.data.summary.evaluatedCount).toBe(0);
    });

    it("does not expose another organization's recommendations or Learning outcomes", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const itemA = await createItem(kitchenA.token, 'SecretRiceA');
        await seedHistory(itemA.id, HISTORY_START, 14, 100);
        const evaluated = await request(app).post('/api/prevention/evaluate').set(auth(kitchenA.token)).send({ menuItemId: itemA.id, targetDate: TARGET, plannedQuantity: 300 });
        await request(app).patch(`/api/prevention/${evaluated.body.data.recommendationId}/status`).set(auth(kitchenA.token)).send({ status: 'approved' });
        await insertActual(itemA.id, TARGET, { prepared: 100, leftover: 0 });
        await request(app).post('/api/learning/evaluate').set(auth(kitchenA.token)).send({ targetDate: TARGET });

        expect((await performance(kitchenA.token)).body.data.interventions.items).toHaveLength(1);
        const resB = await performance(kitchenB.token);
        expect(resB.body.data.interventions.items).toEqual([]);
        expect(resB.body.data.interventions.summary.decidedCount).toBe(0);
    });
});

describe('GET /api/analytics/forecast-performance - intervention linkage (closed loop)', () => {
    async function loop(token, { evaluateLearning = true } = {}) {
        const item = await createItem(token, 'Rice');
        await seedHistory(item.id, HISTORY_START, 14, 100);

        // FORECAST -> prevention recommendation (planned 300 against a ~105 forecast)
        const evaluation = await request(app).post('/api/prevention/evaluate').set(auth(token)).send({ menuItemId: item.id, targetDate: TARGET, plannedQuantity: 300 });
        expect(evaluation.status).toBe(200);
        expect(evaluation.body.data.riskLevel).toBe('HIGH');
        const recommendationId = evaluation.body.data.recommendationId;
        const approved = await request(app).patch(`/api/prevention/${recommendationId}/status`).set(auth(token)).send({ status: 'approved' });
        expect(approved.status).toBe(200);

        // ACTUAL DAILY LOG: they followed the recommendation and wasted nothing
        await insertActual(item.id, TARGET, { prepared: 100, leftover: 0 });

        // LEARNING METRIC / INTERVENTION EFFECTIVENESS
        let learning = null;
        if (evaluateLearning) {
            learning = await request(app).post('/api/learning/evaluate').set(auth(token)).send({ targetDate: TARGET });
            expect(learning.status).toBe(200);
        }
        return { item, recommendationId, learning };
    }

    it('links the recommendation to its forecast, the actual outcome and the learning score', async () => {
        const kitchen = await registerKitchen();
        const { item, recommendationId, learning } = await loop(kitchen.token);
        expect(learning.body.data).toHaveLength(1);
        expect(learning.body.data[0].effectivenessScore).toBe(1);

        const { data } = (await performance(kitchen.token)).body;
        expect(data.interventions.items).toHaveLength(1);
        const item0 = data.interventions.items[0];

        expect(item0).toMatchObject({
            recommendationId,
            menuItemId: item.id,
            menuItemName: 'Rice',
            targetDate: TARGET,
            managerAction: 'approved',
            riskLevel: 'HIGH',
            recommendedQuantity: 105,
        });
        expect(item0.forecast).toMatchObject({ linked: true, predictedQuantity: 105, modelVersion: 'stat_context_v2' });
        expect(item0.forecast.predictedQuantity).toBe(item0.recommendedQuantity); // the recommendation was based on this forecast
        expect(item0.actual).toEqual({ preparedQuantity: 100, consumedQuantity: 100, leftoverQuantity: 0 });
        expect(item0.forecastError).toMatchObject({ error: 5, direction: 'over' });
        expect(item0.outcome).toMatchObject({ evaluated: true, effectivenessScore: 1 });
        expect(item0.outcome.evaluatedAt).toEqual(expect.any(String));

        expect(data.interventions.summary).toMatchObject({
            decidedCount: 1,
            evaluatedCount: 1,
            pendingEvaluationCount: 0,
            awaitingActualCount: 0,
            averageEffectivenessScore: 1,
            positiveOutcomeShare: 100,
            approved: { decidedCount: 1, evaluatedCount: 1, averageEffectivenessScore: 1 },
        });

        // the same forecast is also scored as a plain forecast-vs-actual record
        const record = data.records.find((r) => r.targetDate === TARGET);
        expect(record).toMatchObject({ status: 'evaluated', forecast: { source: 'stored', predictedQuantity: 105 }, actual: { consumedQuantity: 100 } });
    });

    it('shows a decided recommendation as pending evaluation until the Learning score exists', async () => {
        const kitchen = await registerKitchen();
        await loop(kitchen.token, { evaluateLearning: false });
        const { interventions } = (await performance(kitchen.token)).body.data;
        expect(interventions.items[0].outcome).toEqual({ evaluated: false, effectivenessScore: null, evaluatedAt: null });
        expect(interventions.summary).toMatchObject({ decidedCount: 1, evaluatedCount: 0, pendingEvaluationCount: 1 });
    });

    it('reports one outcome per recommendation even if the Learning evaluation was run repeatedly', async () => {
        const kitchen = await registerKitchen();
        await loop(kitchen.token);
        await request(app).post('/api/learning/evaluate').set(auth(kitchen.token)).send({ targetDate: TARGET });
        await request(app).post('/api/learning/evaluate').set(auth(kitchen.token)).send({ targetDate: TARGET });

        const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ai_interventions');
        expect(rows[0].n).toBeGreaterThan(1); // the existing module appends on every run...

        const { interventions } = (await performance(kitchen.token)).body.data;
        expect(interventions.items).toHaveLength(1); // ...but the analytics read the latest one only
        expect(interventions.summary.evaluatedCount).toBe(1);
    });

    it('marks a recommendation as awaiting the actual when no log exists yet', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedHistory(item.id, HISTORY_START, 14, 100);
        const evaluation = await request(app).post('/api/prevention/evaluate').set(auth(kitchen.token)).send({ menuItemId: item.id, targetDate: TARGET, plannedQuantity: 300 });
        await request(app).patch(`/api/prevention/${evaluation.body.data.recommendationId}/status`).set(auth(kitchen.token)).send({ status: 'rejected' });

        const { interventions } = (await performance(kitchen.token)).body.data;
        expect(interventions.items[0]).toMatchObject({ managerAction: 'rejected', actual: null, forecastError: null });
        expect(interventions.summary.awaitingActualCount).toBe(1);
    });

    it('ignores recommendations that are still undecided', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedHistory(item.id, HISTORY_START, 14, 100);
        await request(app).post('/api/prevention/evaluate').set(auth(kitchen.token)).send({ menuItemId: item.id, targetDate: TARGET, plannedQuantity: 300 });
        const { interventions } = (await performance(kitchen.token)).body.data;
        expect(interventions.items).toEqual([]);
    });
});

describe('GET /api/analytics/forecast-performance - response hygiene', () => {
    it('does not expose internal database fields', async () => {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token);
        await seedHistory(item.id, HISTORY_START, 14, 100);
        await requestForecast(kitchen.token, item.id, TARGET);
        await insertActual(item.id, TARGET, { consumed: 100 });

        const keys = collectKeys((await performance(kitchen.token)).body);
        ['kitchen_org_id', 'organization_id', 'key_factors', 'created_by', 'password_hash', 'supporting_evidence', 'recommendation_text'].forEach((internal) => {
            expect(keys.has(internal)).toBe(false);
        });
    });
});
