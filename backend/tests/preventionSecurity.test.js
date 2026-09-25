const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, localDateString } = require('./testHelpers');

// Auth/RBAC/ownership coverage for the Prevention routes now that they run on the
// standard authenticate/authorize middleware, using a real database and real JWTs
// (the mocked-db tests in prevention.test.js cover the fast RBAC/business-logic
// paths; these cover what only a real authenticate() can exercise: missing/invalid
// tokens and the inactive-user check).

async function createMenuItem(token) {
    const res = await request(app)
        .post('/api/menu-items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rice', unit: 'kg' });
    return res.body.menuItem;
}

async function createStaffUser(managerToken, email) {
    await request(app)
        .post('/api/auth/users')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Kitchen Staff', email, password: 'password123', role: 'KITCHEN_STAFF' });

    const loginRes = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    return loginRes.body.token;
}

describe('Prevention routes - authentication middleware consolidation', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects a request with no token', async () => {
        const res = await request(app)
            .post('/api/prevention/evaluate')
            .send({ menuItemId: 1, targetDate: localDateString(), plannedQuantity: 10 });
        expect(res.status).toBe(401);
    });

    it('rejects a request with an invalid/garbage token', async () => {
        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('Authorization', 'Bearer not-a-real-jwt')
            .send({ menuItemId: 1, targetDate: localDateString(), plannedQuantity: 10 });
        expect(res.status).toBe(401);
    });

    it('rejects a deactivated user even with a previously-valid token', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ menuItemId: menuItem.id, targetDate: localDateString(), plannedQuantity: 10 });
        expect(res.status).toBe(401);
    });

    it('rejects an NGO role on /evaluate', async () => {
        const ngo = await registerNgo();
        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ menuItemId: 1, targetDate: localDateString(), plannedQuantity: 10 });
        expect(res.status).toBe(403);
    });

    it('lets an authorized KITCHEN_MANAGER evaluate', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ menuItemId: menuItem.id, targetDate: localDateString(), plannedQuantity: 10 });

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveProperty('riskLevel');
    });

    it('lets an authorized KITCHEN_STAFF evaluate (allowed by RBAC)', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        const staffToken = await createStaffUser(kitchen.token, `staff${Date.now()}@example.com`);

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('Authorization', `Bearer ${staffToken}`)
            .send({ menuItemId: menuItem.id, targetDate: localDateString(), plannedQuantity: 10 });

        expect(res.status).toBe(200);
    });

    it('blocks KITCHEN_STAFF from approving/rejecting a recommendation', async () => {
        const kitchen = await registerKitchen();
        const staffToken = await createStaffUser(kitchen.token, `staff${Date.now()}@example.com`);

        const res = await request(app)
            .patch('/api/prevention/1/status')
            .set('Authorization', `Bearer ${staffToken}`)
            .send({ status: 'approved' });

        expect(res.status).toBe(403);
    });

    it("still blocks a kitchen from evaluating another kitchen's menu item (ownership preserved)", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const menuItem = await createMenuItem(kitchenA.token);

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('Authorization', `Bearer ${kitchenB.token}`)
            .send({ menuItemId: menuItem.id, targetDate: localDateString(), plannedQuantity: 10 });

        expect(res.status).toBe(403);
    });
});
