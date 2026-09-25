const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, localDateString } = require('./testHelpers');

async function createMenuItem(token, overrides = {}) {
    const res = await request(app)
        .post('/api/menu-items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rice', unit: 'kg', ...overrides });
    return res.body.menuItem;
}

describe('GET /api/forecasts/:menuItemId', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('rejects a request with no auth token', async () => {
        const res = await request(app).get('/api/forecasts/1');
        expect(res.status).toBe(401);
    });

    it('rejects an NGO role (RBAC unaffected by the ownership fix)', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        const ngo = await registerNgo();

        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}`)
            .set('Authorization', `Bearer ${ngo.token}`);
        expect(res.status).toBe(403);
    });

    it("blocks a kitchen from forecasting another kitchen's menu item", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const menuItem = await createMenuItem(kitchenA.token);

        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}`)
            .set('Authorization', `Bearer ${kitchenB.token}`);
        expect(res.status).toBe(403);
    });

    it('returns 404 for a menu item that does not exist', async () => {
        const kitchen = await registerKitchen();

        const res = await request(app)
            .get('/api/forecasts/999999')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(404);
    });

    it('lets the owning kitchen fetch its own forecast', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=${localDateString(1)}`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data).toHaveProperty('predictedQuantity');
    });
});

async function createLog(token, menuItemId, logDate, overrides = {}) {
    const res = await request(app)
        .post('/api/daily-logs')
        .set('Authorization', `Bearer ${token}`)
        .send({
            menuItemId,
            logDate,
            mealSlot: 'LUNCH',
            quantityPrepared: 120,
            quantityConsumed: 100,
            quantityLeftover: 20,
            ...overrides,
        });
    expect(res.status).toBe(201);
    return res.body.log;
}

function isoDay(base, offset) {
    return new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

describe('GET /api/forecasts/:menuItemId - upgraded engine, API contract and safety', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('keeps the response contract when there is no history (deterministic fallback)', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=2026-03-10`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(Object.keys(res.body.data).sort()).toEqual(['confidenceScore', 'keyFactors', 'modelVersion', 'predictedQuantity']);
        expect(res.body.data.modelVersion).toBe('heuristic_fallback_v1');
        expect(res.body.data.predictedQuantity).toBe(0);
        expect(res.body.data.confidenceScore).toBe(0.3);
        expect(res.body.data.keyFactors.reason).toBe('Insufficient historical data');
    });

    it('uses the context-aware model with history and exposes the explainability fields', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        for (let i = 0; i < 14; i += 1) {
            await createLog(kitchen.token, menuItem.id, isoDay('2026-02-24', i), { quantityConsumed: 100, quantityPrepared: 120, quantityLeftover: 20 });
        }

        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=2026-03-10`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        const { predictedQuantity, confidenceScore, modelVersion, keyFactors } = res.body.data;
        expect(modelVersion).toBe('stat_context_v2');
        expect(predictedQuantity).toBe(105);
        expect(confidenceScore).toBeGreaterThan(0.35);
        expect(confidenceScore).toBeLessThanOrEqual(0.95);
        ['recent_avg', 'weekday_avg', 'trend_multiplier', 'safety_buffer', 'data_points_used'].forEach((key) => {
            expect(keyFactors).toHaveProperty(key);
        });
        expect(keyFactors.data_points_used).toBe(14);
        expect(Object.keys(keyFactors.signals).sort()).toEqual(['attendance', 'historical_demand', 'trend', 'weekday']);
        expect(typeof keyFactors.reason).toBe('string');
        expect(keyFactors.forecast_confidence.score).toBe(confidenceScore);
        expect(keyFactors.expected_range.low).toBeLessThanOrEqual(keyFactors.expected_range.high);
    });

    it('never lets logs dated on or after the target date influence the forecast', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        for (let i = 0; i < 14; i += 1) {
            await createLog(kitchen.token, menuItem.id, isoDay('2026-02-24', i));
        }
        const url = `/api/forecasts/${menuItem.id}?targetDate=2026-03-10`;
        const before = await request(app).get(url).set('Authorization', `Bearer ${kitchen.token}`);

        // Outcomes on the target day and afterwards - far larger than anything in the history.
        for (let i = 0; i < 4; i += 1) {
            await createLog(kitchen.token, menuItem.id, isoDay('2026-03-10', i), { quantityConsumed: 5000, quantityPrepared: 6000, quantityLeftover: 1000 });
        }
        const after = await request(app).get(url).set('Authorization', `Bearer ${kitchen.token}`);

        expect(after.body.data.predictedQuantity).toBe(before.body.data.predictedQuantity);
        expect(after.body.data.confidenceScore).toBe(before.body.data.confidenceScore);
        expect(after.body.data.keyFactors.central_estimate).toBe(before.body.data.keyFactors.central_estimate);
        expect(after.body.data.keyFactors.data_points_used).toBe(14);
    });

    it('returns identical forecasts for repeated identical requests', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        for (let i = 0; i < 10; i += 1) {
            await createLog(kitchen.token, menuItem.id, isoDay('2026-02-24', i), { quantityConsumed: 90 + i * 3, quantityPrepared: 140, quantityLeftover: 140 - (90 + i * 3), headcount: 80 + i * 2 });
        }
        const url = `/api/forecasts/${menuItem.id}?targetDate=2026-03-10`;
        const first = await request(app).get(url).set('Authorization', `Bearer ${kitchen.token}`);
        const second = await request(app).get(url).set('Authorization', `Bearer ${kitchen.token}`);
        expect(second.body.data).toEqual(first.body.data);
    });

    it('persists each forecast with its model version and explainability in ai_forecasts', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        for (let i = 0; i < 6; i += 1) {
            await createLog(kitchen.token, menuItem.id, isoDay('2026-02-24', i));
        }
        await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=2026-03-10`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        const { rows } = await pool.query('SELECT model_version, target_date, key_factors FROM ai_forecasts WHERE menu_item_id = $1', [menuItem.id]);
        expect(rows).toHaveLength(1);
        expect(rows[0].model_version).toBe('stat_context_v2');
        expect(String(rows[0].target_date).slice(0, 10)).toBe('2026-03-10');
        expect(rows[0].key_factors.signals).toBeDefined();
        expect(rows[0].key_factors.leakage_guard).toBeDefined();
    });

    it('accepts an optional expectedHeadcount and reports how it was used', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        for (let i = 0; i < 10; i += 1) {
            const heads = 60 + i * 8;
            await createLog(kitchen.token, menuItem.id, isoDay('2026-02-24', i), {
                headcount: heads, quantityConsumed: heads * 0.9, quantityPrepared: heads, quantityLeftover: heads * 0.1,
            });
        }

        const low = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=2026-03-10&expectedHeadcount=60`)
            .set('Authorization', `Bearer ${kitchen.token}`);
        const high = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=2026-03-10&expectedHeadcount=140`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(low.status).toBe(200);
        expect(high.status).toBe(200);
        expect(high.body.data.keyFactors.signals.attendance.used).toBe(true);
        expect(high.body.data.keyFactors.signals.attendance.expected_headcount_source).toBe('provided');
        expect(high.body.data.predictedQuantity).toBeGreaterThan(low.body.data.predictedQuantity);
    });

    it.each(['abc', '0', '-5', '1e9', ''])('rejects an invalid expectedHeadcount (%p) with 400', async (bad) => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=2026-03-10&expectedHeadcount=${bad}`)
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(400);
    });

    it.each(['tomorrow', '2026-13-45', '2026-02-30', '10-03-2026'])('rejects an invalid targetDate (%p) with 400', async (bad) => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=${bad}`)
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(400);
    });

    it('checks authorization before validating input (no information leak to other kitchens)', async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const menuItem = await createMenuItem(kitchenA.token);
        const res = await request(app)
            .get(`/api/forecasts/${menuItem.id}?targetDate=garbage&expectedHeadcount=-1`)
            .set('Authorization', `Bearer ${kitchenB.token}`);
        expect(res.status).toBe(403);
    });

    it("does not read another kitchen's logs: forecasts are per menu item", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const itemA = await createMenuItem(kitchenA.token);
        const itemB = await createMenuItem(kitchenB.token);
        for (let i = 0; i < 10; i += 1) {
            await createLog(kitchenA.token, itemA.id, isoDay('2026-02-24', i), { quantityConsumed: 1000, quantityPrepared: 1100, quantityLeftover: 100 });
        }
        const res = await request(app)
            .get(`/api/forecasts/${itemB.id}?targetDate=2026-03-10`)
            .set('Authorization', `Bearer ${kitchenB.token}`);
        expect(res.status).toBe(200);
        expect(res.body.data.modelVersion).toBe('heuristic_fallback_v1');
        expect(res.body.data.predictedQuantity).toBe(0);
    });
});

describe('GET /api/forecasts/:menuItemId?persist=false (read-only preview for dashboards)', () => {
    let kitchen;
    let item;

    beforeEach(async () => {
        await resetDb();
        kitchen = await registerKitchen();
        item = await createMenuItem(kitchen.token);
        for (let i = 0; i < 8; i += 1) {
            await createLog(kitchen.token, item.id, isoDay('2026-02-24', i));
        }
    });

    const forecast = (query) => request(app).get(`/api/forecasts/${item.id}?targetDate=2026-03-10${query}`).set('Authorization', `Bearer ${kitchen.token}`);
    const stored = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM ai_forecasts WHERE menu_item_id = $1', [item.id])).rows[0].n;

    it('returns the same forecast but stores nothing', async () => {
        const preview = await forecast('&persist=false');
        expect(preview.status).toBe(200);
        expect(await stored()).toBe(0);
        const saved = await forecast('');
        expect(await stored()).toBe(1);
        expect(preview.body.data).toEqual(saved.body.data);
    });

    it('any number of previews leaves the stored forecasts (and forecast-vs-actual analytics) untouched', async () => {
        for (let i = 0; i < 5; i += 1) await forecast('&persist=false');
        expect(await stored()).toBe(0);
        await forecast('&persist=true');
        expect(await stored()).toBe(1);
    });

    it('still saves by default, so existing callers are unchanged', async () => {
        await forecast('');
        await forecast('');
        expect(await stored()).toBe(2);
    });

    it('rejects any other value with 400 and stores nothing', async () => {
        for (const bad of ['yes', '0', '', 'FALSE']) {
            const res = await forecast(`&persist=${bad}`);
            expect([bad, res.status]).toEqual([bad, 400]);
        }
        expect(await stored()).toBe(0);
    });

    it('keeps authorization and ownership checks for previews', async () => {
        const other = await registerKitchen({ organizationName: 'Other' });
        expect((await request(app).get(`/api/forecasts/${item.id}?targetDate=2026-03-10&persist=false`).set('Authorization', `Bearer ${other.token}`)).status).toBe(403);
        expect((await request(app).get(`/api/forecasts/${item.id}?persist=false`)).status).toBe(401);
    });
});

// One shared pool: it is closed once, after every describe block in this file has run.
afterAll(async () => {
    await pool.end();
});
