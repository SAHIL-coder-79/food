const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin } = require('./testHelpers');
const { EVENT_TYPES } = require('../src/ai/forecastEngine');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const FUTURE = '2099-06-15'; // a date long after any seeded history
const PAST_TARGET = '2026-02-24';
const HISTORY_START = '2026-02-10'; // 14 days: Feb 10 .. Feb 23, flat 100 -> plain forecast 105

const validEvent = (overrides = {}) => ({
    eventDate: FUTURE,
    eventType: 'festival',
    name: 'Harvest Festival',
    description: 'Campus-wide fair',
    expectedImpactPct: 50,
    ...overrides,
});

const postEvent = (token, body) => request(app).post('/api/events').set(auth(token)).send(body);
const listEvents = (token, query = '') => request(app).get(`/api/events${query}`).set(auth(token));
const deleteEvent = (token, id) => request(app).delete(`/api/events/${id}`).set(auth(token));
const requestForecast = (token, itemId, date) => request(app).get(`/api/forecasts/${itemId}?targetDate=${date}`).set(auth(token));
const countEvents = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM organization_events')).rows[0].n;

async function createItem(token, name = 'Rice') {
    const res = await request(app).post('/api/menu-items').set(auth(token)).send({ name, unit: 'kg' });
    expect(res.status).toBe(201);
    return res.body.menuItem;
}

async function seedHistory(itemId, start, days, consumed) {
    await pool.query(
        `INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed)
         SELECT $1, ($2::date + g), 'LUNCH', $3::float + 20, 20, $3::float FROM generate_series(0, $4::int - 1) g`,
        [itemId, start, consumed, days]
    );
}

async function staffToken(managerToken) {
    const email = `staff${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    await request(app).post('/api/auth/users').set(auth(managerToken)).send({ name: 'Staff', email, password: 'password123', role: 'KITCHEN_STAFF' });
    return (await request(app).post('/api/auth/login').send({ email, password: 'password123' })).body.token;
}

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

describe('Events API - authentication and RBAC', () => {
    const endpoints = [
        ['post', '/api/events', validEvent()],
        ['get', '/api/events', {}],
        ['delete', '/api/events/1', {}],
    ];

    it.each(endpoints)('%s %s rejects a request with no token', async (method, path, body) => {
        expect((await request(app)[method](path).send(body)).status).toBe(401);
    });

    it.each(endpoints)('%s %s rejects an invalid token', async (method, path, body) => {
        expect((await request(app)[method](path).set('Authorization', 'Bearer not-a-real-jwt').send(body)).status).toBe(401);
    });

    it.each(endpoints)('%s %s rejects a deactivated user', async (method, path, body) => {
        const kitchen = await registerKitchen();
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);
        expect((await request(app)[method](path).set(auth(kitchen.token)).send(body)).status).toBe(401);
    });

    it.each(endpoints)('%s %s rejects NGO roles and system admins', async (method, path, body) => {
        const ngo = await registerNgo();
        expect((await request(app)[method](path).set(auth(ngo.token)).send(body)).status).toBe(403);
        const { token } = await createSystemAdmin();
        expect((await request(app)[method](path).set(auth(token)).send(body)).status).toBe(403);
    });

    it('lets kitchen staff read the calendar but only managers change it', async () => {
        const manager = await registerKitchen();
        const created = await postEvent(manager.token, validEvent());
        expect(created.status).toBe(201);
        const staff = await staffToken(manager.token);

        expect((await listEvents(staff)).status).toBe(200);
        expect((await listEvents(staff)).body.events).toHaveLength(1);
        expect((await postEvent(staff, validEvent({ name: 'Other' }))).status).toBe(403);
        expect((await deleteEvent(staff, created.body.event.id)).status).toBe(403);
        expect(await countEvents()).toBe(1);
    });
});

describe('Events API - create, list, delete', () => {
    it('creates an organization-scoped event without exposing internal fields', async () => {
        const kitchen = await registerKitchen();
        const res = await postEvent(kitchen.token, validEvent());

        expect(res.status).toBe(201);
        expect(res.body.event).toMatchObject({ eventDate: FUTURE, eventType: 'festival', name: 'Harvest Festival', description: 'Campus-wide fair', expectedImpactPct: 50 });
        expect(Object.keys(res.body.event).sort()).toEqual(['createdAt', 'description', 'eventDate', 'eventType', 'expectedImpactPct', 'id', 'name']);
        const { rows } = await pool.query('SELECT organization_id, created_by FROM organization_events WHERE id = $1', [res.body.event.id]);
        expect(rows[0]).toEqual({ organization_id: kitchen.organization.id, created_by: kitchen.user.id });
    });

    it('allows every supported event type and optional fields to be omitted', async () => {
        const kitchen = await registerKitchen();
        for (const eventType of EVENT_TYPES) {
            const res = await postEvent(kitchen.token, { eventDate: FUTURE, eventType, name: `A ${eventType}` });
            expect(res.status).toBe(201);
            expect(res.body.event).toMatchObject({ eventType, description: null, expectedImpactPct: null });
        }
        expect(await countEvents()).toBe(EVENT_TYPES.length);
    });

    it('accepts impact values across the allowed range', async () => {
        const kitchen = await registerKitchen();
        for (const [i, expectedImpactPct] of [-100, -30, 0, 25.5, 500].entries()) {
            expect((await postEvent(kitchen.token, validEvent({ name: `E${i}`, expectedImpactPct }))).status).toBe(201);
        }
    });

    it.each([
        ['missing date', { eventDate: undefined }],
        ['relative date', { eventDate: 'tomorrow' }],
        ['impossible date', { eventDate: '2026-02-30' }],
        ['wrong format', { eventDate: '15-06-2099' }],
        ['numeric date', { eventDate: 20990615 }],
        ['unknown type', { eventType: 'party' }],
        ['missing type', { eventType: undefined }],
        ['missing name', { name: undefined }],
        ['blank name', { name: '   ' }],
        ['non-text name', { name: 42 }],
        ['over-long name', { name: 'N'.repeat(256) }],
        ['non-text description', { description: 7 }],
        ['over-long description', { description: 'D'.repeat(2001) }],
        ['impact below -100', { expectedImpactPct: -101 }],
        ['impact above 500', { expectedImpactPct: 501 }],
        ['non-numeric impact', { expectedImpactPct: 'lots' }],
    ])('rejects an event with %s (400) and stores nothing', async (_label, overrides) => {
        const kitchen = await registerKitchen();
        const body = validEvent(overrides);
        Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);
        expect((await postEvent(kitchen.token, body)).status).toBe(400);
        expect(await countEvents()).toBe(0);
    });

    it('rejects an exact duplicate (409) but allows different types or names on the same date', async () => {
        const kitchen = await registerKitchen();
        expect((await postEvent(kitchen.token, validEvent())).status).toBe(201);
        expect((await postEvent(kitchen.token, validEvent())).status).toBe(409);
        expect((await postEvent(kitchen.token, validEvent({ eventType: 'special_meal' }))).status).toBe(201);
        expect((await postEvent(kitchen.token, validEvent({ name: 'Another Festival' }))).status).toBe(201);
    });

    it('lists events in date order with range and type filters', async () => {
        const kitchen = await registerKitchen();
        await postEvent(kitchen.token, validEvent({ eventDate: '2099-03-01', name: 'March', eventType: 'holiday' }));
        await postEvent(kitchen.token, validEvent({ eventDate: '2099-01-01', name: 'January', eventType: 'holiday' }));
        await postEvent(kitchen.token, validEvent({ eventDate: '2099-02-01', name: 'February', eventType: 'exam' }));

        expect((await listEvents(kitchen.token)).body.events.map((e) => e.name)).toEqual(['January', 'February', 'March']);
        expect((await listEvents(kitchen.token, '?startDate=2099-02-01&endDate=2099-02-28')).body.events.map((e) => e.name)).toEqual(['February']);
        expect((await listEvents(kitchen.token, '?eventType=holiday')).body.events.map((e) => e.name)).toEqual(['January', 'March']);
        expect((await listEvents(kitchen.token, '?limit=1')).body.events).toHaveLength(1);
    });

    it.each(['?startDate=yesterday', '?startDate=2099-02-01&endDate=2099-01-01', '?eventType=party', '?limit=0', '?limit=9999', '?offset=-1'])(
        'rejects an invalid list query %s with 400',
        async (query) => {
            const kitchen = await registerKitchen();
            expect((await listEvents(kitchen.token, query)).status).toBe(400);
        }
    );

    it('deletes an event', async () => {
        const kitchen = await registerKitchen();
        const { event } = (await postEvent(kitchen.token, validEvent())).body;
        const res = await deleteEvent(kitchen.token, event.id);
        expect(res.status).toBe(200);
        expect(res.body.event.id).toBe(event.id);
        expect(await countEvents()).toBe(0);
        expect((await deleteEvent(kitchen.token, event.id)).status).toBe(404);
        expect((await deleteEvent(kitchen.token, 'abc')).status).toBe(400);
    });
});

describe('Events API - organization isolation', () => {
    it("never lists or reveals another organization's events", async () => {
        const a = await registerKitchen();
        const b = await registerKitchen();
        await postEvent(a.token, validEvent({ name: 'SecretFestivalA' }));
        await postEvent(b.token, validEvent({ name: 'PlainHolidayB', eventType: 'holiday' }));

        const resB = await listEvents(b.token);
        expect(resB.body.events.map((e) => e.name)).toEqual(['PlainHolidayB']);
        expect(JSON.stringify(resB.body)).not.toContain('SecretFestivalA');
        expect((await listEvents(a.token)).body.events.map((e) => e.name)).toEqual(['SecretFestivalA']);
    });

    it("blocks deleting another organization's event and leaves it in place", async () => {
        const a = await registerKitchen();
        const b = await registerKitchen();
        const { event } = (await postEvent(a.token, validEvent())).body;

        expect((await deleteEvent(b.token, event.id)).status).toBe(404);
        expect(await countEvents()).toBe(1);
    });

    it('ignores any organization identifier supplied by the client', async () => {
        const a = await registerKitchen();
        const b = await registerKitchen();
        const res = await postEvent(b.token, { ...validEvent(), organizationId: a.organization.id, organization_id: a.organization.id });
        expect(res.status).toBe(201);
        expect((await listEvents(a.token)).body.events).toEqual([]);
        expect((await listEvents(b.token, `?organizationId=${a.organization.id}`)).body.events).toHaveLength(1);
        const { rows } = await pool.query('SELECT organization_id FROM organization_events');
        expect(rows[0].organization_id).toBe(b.organization.id);
    });

    it('does not expose internal database fields', async () => {
        const kitchen = await registerKitchen();
        await postEvent(kitchen.token, validEvent());
        const keys = collectKeys((await listEvents(kitchen.token)).body);
        ['organization_id', 'created_by', 'event_type', 'event_date'].forEach((internal) => expect(keys.has(internal)).toBe(false));
    });
});

describe('organization_events table constraints (migration 011)', () => {
    it('matches the supported event types and impact bounds', async () => {
        const { rows } = await pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'organization_events_type_check'");
        EVENT_TYPES.forEach((type) => expect(rows[0].def).toContain(`'${type}'`));

        const kitchen = await registerKitchen();
        const insert = (type, impact) =>
            pool.query(
                "INSERT INTO organization_events (organization_id, event_date, event_type, name, expected_impact_pct) VALUES ($1, '2099-01-01', $2, 'x', $3)",
                [kitchen.organization.id, type, impact]
            );
        await expect(insert('party', null)).rejects.toMatchObject({ code: '23514' });
        await expect(insert('holiday', -101)).rejects.toMatchObject({ code: '23514' });
        await expect(insert('holiday', 501)).rejects.toMatchObject({ code: '23514' });
        await expect(insert('holiday', 20)).resolves.toBeDefined();
        await expect(insert('holiday', 20)).rejects.toMatchObject({ code: '23505' });
    });

    it('requires a real organization', async () => {
        await expect(
            pool.query("INSERT INTO organization_events (organization_id, event_date, event_type, name) VALUES (999999, '2099-01-01', 'holiday', 'x')")
        ).rejects.toMatchObject({ code: '23503' });
    });
});

describe('Events feed the real forecast endpoint (optional context)', () => {
    async function kitchenWithHistory(name = 'Rice') {
        const kitchen = await registerKitchen();
        const item = await createItem(kitchen.token, name);
        await seedHistory(item.id, HISTORY_START, 14, 100);
        return { kitchen, item };
    }

    it('works exactly as before when the organization has no events', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        const res = await requestForecast(kitchen.token, item.id, FUTURE);
        expect(res.status).toBe(200);
        expect(res.body.data.modelVersion).toBe('stat_context_v2');
        expect(res.body.data.predictedQuantity).toBe(105);
        expect(res.body.data.keyFactors).not.toHaveProperty('event_context');
    });

    it('applies a positive event on the target date and explains it in keyFactors', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        await postEvent(kitchen.token, validEvent()); // +50% festival on FUTURE

        const res = await requestForecast(kitchen.token, item.id, FUTURE);
        expect(res.body.data.predictedQuantity).toBe(157.5); // 100 x 1.5 x 1.05
        const context = res.body.data.keyFactors.event_context;
        expect(context.applied).toBe(true);
        expect(context.target_events).toEqual([{ type: 'festival', name: 'Harvest Festival', expected_impact_pct: 50 }]);
        expect(context.adjustment).toMatchObject({ factor: 1.5, evidence: 'declared', applied_to: 'full_estimate', baseline_estimate: 100 });
        expect(res.body.data.keyFactors.reason).toMatch(/Harvest Festival \(festival\)/);
    });

    it('applies a reduced-demand event, down to zero for a closure', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        await postEvent(kitchen.token, validEvent({ eventType: 'exam', name: 'Finals', expectedImpactPct: -30 }));
        expect((await requestForecast(kitchen.token, item.id, FUTURE)).body.data.predictedQuantity).toBeCloseTo(73.5, 0);

        await postEvent(kitchen.token, validEvent({ eventDate: '2099-06-16', eventType: 'closure', name: 'Closed', expectedImpactPct: -100 }));
        const closed = await requestForecast(kitchen.token, item.id, '2099-06-16');
        expect(closed.body.data.predictedQuantity).toBe(0);
        expect(closed.body.data.keyFactors.event_context.adjustment.factor).toBe(0);
    });

    it('only affects the date the event is on', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        await postEvent(kitchen.token, validEvent({ eventDate: '2099-06-16' })); // the day AFTER the target
        const res = await requestForecast(kitchen.token, item.id, FUTURE);
        expect(res.body.data.predictedQuantity).toBe(105);
        expect(res.body.data.keyFactors).not.toHaveProperty('event_context');
    });

    it("never lets one organization's events change another organization's forecast", async () => {
        const a = await kitchenWithHistory('SecretRiceA');
        const b = await kitchenWithHistory('PlainRiceB');
        await postEvent(a.kitchen.token, validEvent({ eventType: 'closure', name: 'A closed', expectedImpactPct: -100 }));

        expect((await requestForecast(a.kitchen.token, a.item.id, FUTURE)).body.data.predictedQuantity).toBe(0);
        const forB = await requestForecast(b.kitchen.token, b.item.id, FUTURE);
        expect(forB.body.data.predictedQuantity).toBe(105);
        expect(JSON.stringify(forB.body)).not.toContain('A closed');
        expect(forB.body.data.keyFactors).not.toHaveProperty('event_context');
    });

    it('removes the effect when the event is deleted', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        const { event } = (await postEvent(kitchen.token, validEvent())).body;
        expect((await requestForecast(kitchen.token, item.id, FUTURE)).body.data.predictedQuantity).toBe(157.5);
        await deleteEvent(kitchen.token, event.id);
        expect((await requestForecast(kitchen.token, item.id, FUTURE)).body.data.predictedQuantity).toBe(105);
    });

    it('keeps labelled past event days out of the baseline for ordinary days', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        await pool.query("UPDATE daily_logs SET quantity_consumed = 300, quantity_prepared = 320, quantity_leftover = 20 WHERE menu_item_id = $1 AND log_date = '2026-02-16'", [item.id]);

        const distorted = (await requestForecast(kitchen.token, item.id, FUTURE)).body.data.predictedQuantity;
        expect(distorted).toBeGreaterThan(105);

        await postEvent(kitchen.token, validEvent({ eventDate: '2026-02-16', name: 'Fair day', expectedImpactPct: undefined }));
        const cleaned = (await requestForecast(kitchen.token, item.id, FUTURE)).body.data;
        expect(cleaned.predictedQuantity).toBe(105);
        expect(cleaned.keyFactors.event_context).toMatchObject({ applied: false, history_event_days_excluded: 1, target_events: [] });
    });

    describe('no future leakage', () => {
        it('ignores an event for a past date that was only entered afterwards', async () => {
            const { kitchen, item } = await kitchenWithHistory();
            // dated Feb 24 but created now (months later): it could reflect what happened, so it is not used
            await postEvent(kitchen.token, validEvent({ eventDate: PAST_TARGET, eventType: 'closure', name: 'Recorded afterwards', expectedImpactPct: -100 }));

            const res = await requestForecast(kitchen.token, item.id, PAST_TARGET);
            expect(res.body.data.predictedQuantity).toBe(105);
            expect(res.body.data.keyFactors).not.toHaveProperty('event_context');
        });

        it('uses an event entered today for today', async () => {
            const { kitchen, item } = await kitchenWithHistory();
            const today = new Date().toISOString().slice(0, 10);
            await postEvent(kitchen.token, validEvent({ eventDate: today, eventType: 'closure', name: 'Closed today', expectedImpactPct: -100 }));
            expect((await requestForecast(kitchen.token, item.id, today)).body.data.predictedQuantity).toBe(0);
        });

        it('never reads the target day\'s own logs or later ones, with events present', async () => {
            const { kitchen, item } = await kitchenWithHistory();
            await postEvent(kitchen.token, validEvent()); // FUTURE festival
            const before = (await requestForecast(kitchen.token, item.id, FUTURE)).body.data;

            await seedHistory(item.id, FUTURE, 3, 9999); // the target day and the two after it
            const after = (await requestForecast(kitchen.token, item.id, FUTURE)).body.data;
            expect(after.predictedQuantity).toBe(before.predictedQuantity);
            expect(after.keyFactors.central_estimate).toBe(before.keyFactors.central_estimate);
        });

        it('is deterministic for repeated requests', async () => {
            const { kitchen, item } = await kitchenWithHistory();
            await postEvent(kitchen.token, validEvent());
            const first = (await requestForecast(kitchen.token, item.id, FUTURE)).body.data;
            const second = (await requestForecast(kitchen.token, item.id, FUTURE)).body.data;
            expect(second).toEqual(first);
        });
    });

    it('also reaches the existing consumers of the forecast (prevention) without changing them', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        await postEvent(kitchen.token, validEvent({ eventType: 'closure', name: 'Closed', expectedImpactPct: -100 }));
        const evaluation = await request(app).post('/api/prevention/evaluate').set(auth(kitchen.token)).send({ menuItemId: item.id, targetDate: FUTURE, plannedQuantity: 100 });
        expect(evaluation.status).toBe(200);
        expect(evaluation.body.data.predictedQuantity).toBe(0);
        expect(evaluation.body.data.riskLevel).toBe('HIGH');
    });

    it('applies the same "known by then" rule when forecast accuracy reconstructs historical forecasts', async () => {
        const { kitchen, item } = await kitchenWithHistory();
        await pool.query(
            "INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared, quantity_leftover, quantity_consumed) VALUES ($1, $2, 'LUNCH', 120, 20, 100)",
            [item.id, PAST_TARGET]
        );
        await postEvent(kitchen.token, validEvent({ eventDate: PAST_TARGET, eventType: 'closure', name: 'Recorded afterwards', expectedImpactPct: -100 }));

        const res = await request(app)
            .get(`/api/analytics/forecast-performance?startDate=${PAST_TARGET}&endDate=${PAST_TARGET}`)
            .set(auth(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data.records[0].forecast).toMatchObject({ source: 'reconstructed', predictedQuantity: 105 });
    });
});
