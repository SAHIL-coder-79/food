const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin } = require('./testHelpers');

const URL = '/api/analytics/waste-attribution';

async function createMenuItem(token, name, unit = 'kg') {
    const res = await request(app).post('/api/menu-items').set('Authorization', `Bearer ${token}`).send({ name, unit });
    return res.body.menuItem;
}

async function createLog(token, menuItemId, logDate, mealSlot, quantityPrepared, quantityLeftover, extra = {}) {
    const res = await request(app)
        .post('/api/daily-logs')
        .set('Authorization', `Bearer ${token}`)
        .send({ menuItemId, logDate, mealSlot, quantityPrepared, quantityLeftover, ...extra });
    expect(res.status).toBe(201);
    return res.body.log;
}

// Mon 2026-03-02, Tue 2026-03-03. prepared 300, waste 60 (20%): Rice 45 (75%), Dal 15 (25%).
async function seedKitchen(token) {
    const rice = await createMenuItem(token, 'Rice');
    const dal = await createMenuItem(token, 'Dal');
    await createLog(token, rice.id, '2026-03-02', 'LUNCH', 100, 15);
    await createLog(token, rice.id, '2026-03-03', 'LUNCH', 100, 30);
    await createLog(token, dal.id, '2026-03-02', 'DINNER', 100, 15);
    return { rice, dal };
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

const get = (token, query = '') => request(app).get(`${URL}${query}`).set('Authorization', `Bearer ${token}`);

describe('GET /api/analytics/waste-attribution', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    describe('authentication and RBAC', () => {
        it('rejects a request with no token', async () => {
            const res = await request(app).get(URL);
            expect(res.status).toBe(401);
        });

        it('rejects an invalid token', async () => {
            const res = await request(app).get(URL).set('Authorization', 'Bearer not-a-real-jwt');
            expect(res.status).toBe(401);
        });

        it('rejects a deactivated user', async () => {
            const kitchen = await registerKitchen();
            await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);
            const res = await get(kitchen.token);
            expect(res.status).toBe(401);
        });

        it('rejects NGO roles', async () => {
            const ngo = await registerNgo();
            const res = await get(ngo.token);
            expect(res.status).toBe(403);
        });

        it('rejects a system admin (no kitchen organization to analyse)', async () => {
            const { token } = await createSystemAdmin();
            const res = await get(token);
            expect(res.status).toBe(403);
        });

        it('allows kitchen staff as well as the manager', async () => {
            const kitchen = await registerKitchen();
            const email = `staff${Date.now()}@example.com`;
            await request(app)
                .post('/api/auth/users')
                .set('Authorization', `Bearer ${kitchen.token}`)
                .send({ name: 'Staff', email, password: 'password123', role: 'KITCHEN_STAFF' });
            const login = await request(app).post('/api/auth/login').send({ email, password: 'password123' });

            expect((await get(login.body.token)).status).toBe(200);
            expect((await get(kitchen.token)).status).toBe(200);
        });
    });

    describe('empty organization', () => {
        it('returns a consistent, fully shaped empty result', async () => {
            const kitchen = await registerKitchen();
            const res = await get(kitchen.token);

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('success');
            const { data } = res.body;
            expect(data.totals).toEqual({ logCount: 0, preparedQuantity: 0, consumedQuantity: 0, wasteQuantity: 0, wastePercentage: null });
            expect(data.byMenuItem).toEqual([]);
            expect(data.byMealSlot).toEqual([]);
            expect(data.byWeekday).toEqual([]);
            expect(data.topMenuItems).toEqual([]);
            expect(data.topMealSlots).toEqual([]);
            expect(data.insights).toEqual([]);
            expect(data.patterns).toEqual({ recurringOverPreparation: [], weekdayMealSlotHotspots: [] });
        });

        it('is empty (not an error) for a kitchen that has menu items but no logs', async () => {
            const kitchen = await registerKitchen();
            await createMenuItem(kitchen.token, 'Rice');
            const res = await get(kitchen.token);
            expect(res.status).toBe(200);
            expect(res.body.data.totals.logCount).toBe(0);
        });
    });

    describe('calculations from real logs', () => {
        it('calculates totals and waste percentage', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const { data } = (await get(kitchen.token)).body;

            expect(data.totals).toEqual({ logCount: 3, preparedQuantity: 300, consumedQuantity: 240, wasteQuantity: 60, wastePercentage: 20 });
            expect(data.period.firstLogDate).toBe('2026-03-02');
            expect(data.period.lastLogDate).toBe('2026-03-03');
        });

        it('attributes waste to menu items with contribution percentages', async () => {
            const kitchen = await registerKitchen();
            const { rice, dal } = await seedKitchen(kitchen.token);
            const { data } = (await get(kitchen.token)).body;

            expect(data.byMenuItem.map((i) => i.name)).toEqual(['Rice', 'Dal']);
            expect(data.byMenuItem[0]).toMatchObject({ menuItemId: rice.id, wasteQuantity: 45, contributionPercentage: 75, wastePercentage: 22.5 });
            expect(data.byMenuItem[1]).toMatchObject({ menuItemId: dal.id, wasteQuantity: 15, contributionPercentage: 25 });
            expect(data.topMenuItems.map((i) => i.name)).toEqual(['Rice', 'Dal']);
        });

        it('attributes waste by weekday', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const { data } = (await get(kitchen.token)).body;

            expect(data.byWeekday.map((d) => d.weekdayName)).toEqual(['Monday', 'Tuesday']);
            expect(data.byWeekday[0]).toMatchObject({ wasteQuantity: 30, logCount: 2, contributionPercentage: 50 });
            expect(data.byWeekday[1]).toMatchObject({ wasteQuantity: 30, logCount: 1 });
        });

        it('attributes waste by meal slot', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const { data } = (await get(kitchen.token)).body;

            expect(data.byMealSlot.map((s) => s.mealSlot)).toEqual(['LUNCH', 'DINNER']);
            expect(data.byMealSlot[0]).toMatchObject({ wasteQuantity: 45, contributionPercentage: 75 });
            expect(data.byMealSlot[1]).toMatchObject({ wasteQuantity: 15, contributionPercentage: 25 });
            expect(data.topMealSlots[0].mealSlot).toBe('LUNCH');
        });

        it('generates deterministic insights, identical on repeated calls', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const first = (await get(kitchen.token)).body.data;
            const second = (await get(kitchen.token)).body.data;

            expect(first.insights.length).toBeGreaterThanOrEqual(3);
            expect(first.insights.length).toBeLessThanOrEqual(5);
            expect(first.insights.find((i) => i.type === 'top_waste_contributor').message).toBe('Rice contributed 75% of recorded waste (45 kg).');
            expect(second).toEqual(first);
        });
    });

    describe('date range', () => {
        it('limits the analysis to the requested range and echoes it back', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const { data } = (await get(kitchen.token, '?startDate=2026-03-03&endDate=2026-03-03')).body;

            expect(data.period).toMatchObject({ startDate: '2026-03-03', endDate: '2026-03-03', firstLogDate: '2026-03-03', lastLogDate: '2026-03-03' });
            expect(data.totals).toMatchObject({ logCount: 1, wasteQuantity: 30, preparedQuantity: 100 });
        });

        it('returns an empty result for a range with no logs', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const res = await get(kitchen.token, '?startDate=2027-01-01');
            expect(res.status).toBe(200);
            expect(res.body.data.totals.logCount).toBe(0);
        });

        it.each([
            ['?startDate=yesterday'],
            ['?endDate=2026-13-45'],
            ['?startDate=2026-02-30'],
            ['?startDate=03-02-2026'],
            ['?startDate=2026-03-05&endDate=2026-03-01'],
        ])('rejects an invalid range %s with 400', async (query) => {
            const kitchen = await registerKitchen();
            const res = await get(kitchen.token, query);
            expect(res.status).toBe(400);
        });
    });

    describe('organization isolation (no cross-organization leakage / IDOR)', () => {
        it("never includes another organization's logs or menu items", async () => {
            const kitchenA = await registerKitchen();
            const kitchenB = await registerKitchen();
            const itemA = await createMenuItem(kitchenA.token, 'SecretBiryaniA');
            await createLog(kitchenA.token, itemA.id, '2026-03-02', 'LUNCH', 500, 250);
            const itemB = await createMenuItem(kitchenB.token, 'PlainRiceB');
            await createLog(kitchenB.token, itemB.id, '2026-03-02', 'LUNCH', 100, 10);

            const resB = await get(kitchenB.token);
            expect(resB.status).toBe(200);
            expect(resB.body.data.totals).toMatchObject({ logCount: 1, preparedQuantity: 100, wasteQuantity: 10 });
            expect(resB.body.data.byMenuItem.map((i) => i.name)).toEqual(['PlainRiceB']);
            expect(JSON.stringify(resB.body)).not.toContain('SecretBiryaniA');

            const resA = await get(kitchenA.token);
            expect(resA.body.data.totals).toMatchObject({ logCount: 1, preparedQuantity: 500, wasteQuantity: 250 });
            expect(JSON.stringify(resA.body)).not.toContain('PlainRiceB');
        });

        it("ignores any client-supplied organization identifiers", async () => {
            const kitchenA = await registerKitchen();
            const kitchenB = await registerKitchen();
            const itemA = await createMenuItem(kitchenA.token, 'SecretBiryaniA');
            await createLog(kitchenA.token, itemA.id, '2026-03-02', 'LUNCH', 500, 250);

            const spoofed = await get(
                kitchenB.token,
                `?organizationId=${kitchenA.organization.id}&kitchenOrgId=${kitchenA.organization.id}&orgId=${kitchenA.organization.id}`
            );
            expect(spoofed.status).toBe(200);
            expect(spoofed.body.data.totals.logCount).toBe(0);
            expect(JSON.stringify(spoofed.body)).not.toContain('SecretBiryaniA');

            const spoofedHeader = await request(app)
                .get(URL)
                .set('Authorization', `Bearer ${kitchenB.token}`)
                .set('x-organization-id', String(kitchenA.organization.id));
            expect(spoofedHeader.body.data.totals.logCount).toBe(0);
        });

        it("does not mix a menu item's logs into another kitchen even when names collide", async () => {
            const kitchenA = await registerKitchen();
            const kitchenB = await registerKitchen();
            const itemA = await createMenuItem(kitchenA.token, 'Rice');
            const itemB = await createMenuItem(kitchenB.token, 'Rice');
            await createLog(kitchenA.token, itemA.id, '2026-03-02', 'LUNCH', 100, 50);
            await createLog(kitchenB.token, itemB.id, '2026-03-02', 'LUNCH', 100, 5);

            const { data } = (await get(kitchenB.token)).body;
            expect(data.byMenuItem).toHaveLength(1);
            expect(data.byMenuItem[0]).toMatchObject({ menuItemId: itemB.id, wasteQuantity: 5 });
        });
    });

    describe('response shape', () => {
        it('has the documented top-level shape and per-row fields', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const res = await get(kitchen.token);

            expect(Object.keys(res.body).sort()).toEqual(['data', 'status']);
            expect(Object.keys(res.body.data).sort()).toEqual([
                'byMealSlot', 'byMenuItem', 'byWeekday', 'insights', 'meta', 'patterns', 'period', 'topMealSlots', 'topMenuItems', 'totals',
            ]);
            expect(Object.keys(res.body.data.totals).sort()).toEqual(['consumedQuantity', 'logCount', 'preparedQuantity', 'wastePercentage', 'wasteQuantity']);
            expect(Object.keys(res.body.data.byMenuItem[0]).sort()).toEqual([
                'averageWastePerLog', 'consumedQuantity', 'contributionPercentage', 'logCount', 'menuItemId', 'name', 'preparedQuantity', 'unit', 'wastePercentage', 'wasteQuantity',
            ]);
            expect(Object.keys(res.body.data.byMealSlot[0]).sort()).toEqual([
                'averageWastePerLog', 'consumedQuantity', 'contributionPercentage', 'logCount', 'mealSlot', 'preparedQuantity', 'wastePercentage', 'wasteQuantity',
            ]);
            expect(Object.keys(res.body.data.byWeekday[0]).sort()).toEqual([
                'averageWastePerLog', 'consumedQuantity', 'contributionPercentage', 'logCount', 'preparedQuantity', 'wastePercentage', 'wasteQuantity', 'weekday', 'weekdayName',
            ]);
            res.body.data.insights.forEach((insight) => {
                expect(Object.keys(insight).sort()).toEqual(['evidence', 'message', 'type']);
            });
        });

        it('does not expose internal database fields', async () => {
            const kitchen = await registerKitchen();
            await seedKitchen(kitchen.token);
            const keys = collectKeys((await get(kitchen.token)).body);

            ['id', 'created_by', 'created_at', 'updated_at', 'kitchen_org_id', 'organization_id', 'password_hash', 'headcount', 'batch_number', 'quantity_planned'].forEach((internal) => {
                expect(keys.has(internal)).toBe(false);
            });
        });
    });
});
