const request = require('supertest');
const { app, pool, resetDb, registerKitchen, localDateString } = require('./testHelpers');

async function createMenuItem(token, overrides = {}) {
    const res = await request(app)
        .post('/api/menu-items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: overrides.name || 'Khichdi', unit: overrides.unit || 'kg' });
    return res.body.menuItem;
}

describe('Daily log CRUD', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('creates a daily log entry with planned/prepared/attendance/consumed/leftover fields', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        const res = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                menuItemId: menuItem.id,
                logDate: localDateString(),
                mealSlot: 'LUNCH',
                quantityPlanned: 50,
                quantityPrepared: 55,
                headcount: 48,
                quantityConsumed: 45,
                quantityLeftover: 10,
            });

        expect(res.status).toBe(201);
        expect(res.body.log.quantity_planned).toBe(50);
        expect(res.body.log.quantity_leftover).toBe(10);
    });

    it('rejects a negative quantity with a plain-language validation error', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        const res = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                menuItemId: menuItem.id,
                logDate: localDateString(),
                mealSlot: 'LUNCH',
                quantityPrepared: -5,
            });

        expect(res.status).toBe(400);
        expect(res.body.details[0].message).toMatch(/positive/i);
    });

    it('blocks duplicate entries for the same menu item/date/meal slot', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        const payload = {
            menuItemId: menuItem.id,
            logDate: localDateString(),
            mealSlot: 'DINNER',
            quantityPrepared: 20,
        };

        const first = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send(payload);
        const second = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send(payload);

        expect(first.status).toBe(201);
        expect(second.status).toBe(409);
    });

    it('rejects creating a log for a menu item belonging to another organization', async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const menuItemB = await createMenuItem(kitchenB.token);

        const res = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchenA.token}`)
            .send({
                menuItemId: menuItemB.id,
                logDate: localDateString(),
                mealSlot: 'BREAKFAST',
                quantityPrepared: 10,
            });

        expect(res.status).toBe(403);
    });

    it('allows KITCHEN_STAFF to edit a same-day log but blocks editing a past-day log', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        const staffCreateRes = await request(app)
            .post('/api/auth/users')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                name: 'Staffer',
                email: `staffer${Date.now()}@example.com`,
                password: 'password123',
                role: 'KITCHEN_STAFF',
            });
        const staffLogin = await request(app)
            .post('/api/auth/login')
            .send({ email: staffCreateRes.body.user.email, password: 'password123' });
        const staffToken = staffLogin.body.token;

        const todayLog = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                menuItemId: menuItem.id,
                logDate: localDateString(),
                mealSlot: 'LUNCH',
                quantityPrepared: 10,
            });

        const editToday = await request(app)
            .patch(`/api/daily-logs/${todayLog.body.log.id}`)
            .set('Authorization', `Bearer ${staffToken}`)
            .send({ quantityLeftover: 2 });
        expect(editToday.status).toBe(200);
        expect(editToday.body.log.quantity_leftover).toBe(2);

        const yesterday = localDateString(-1);
        const pastLog = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                menuItemId: menuItem.id,
                logDate: yesterday,
                mealSlot: 'LUNCH',
                quantityPrepared: 10,
            });

        const editPastByStaff = await request(app)
            .patch(`/api/daily-logs/${pastLog.body.log.id}`)
            .set('Authorization', `Bearer ${staffToken}`)
            .send({ quantityLeftover: 2 });
        expect(editPastByStaff.status).toBe(403);

        // KITCHEN_MANAGER may still correct historical entries.
        const editPastByManager = await request(app)
            .patch(`/api/daily-logs/${pastLog.body.log.id}`)
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ quantityLeftover: 3 });
        expect(editPastByManager.status).toBe(200);
    });

    it('lists logs filtered by date range', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        const today = localDateString();

        await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ menuItemId: menuItem.id, logDate: today, mealSlot: 'BREAKFAST', quantityPrepared: 5 });

        const res = await request(app)
            .get(`/api/daily-logs?startDate=${today}&endDate=${today}`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        expect(res.body.logs.length).toBe(1);
    });
});
