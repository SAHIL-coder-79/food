const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, localDateString } = require('./testHelpers');

async function createDailyLog(token) {
    const menuItemRes = await request(app)
        .post('/api/menu-items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rice', unit: 'kg' });
    const menuItemId = menuItemRes.body.menuItem.id;

    const logRes = await request(app)
        .post('/api/daily-logs')
        .set('Authorization', `Bearer ${token}`)
        .send({
            menuItemId,
            logDate: localDateString(),
            mealSlot: 'LUNCH',
            quantityPrepared: 20,
            quantityLeftover: 5,
        });
    return logRes.body.log;
}

describe('GET /api/root-causes/:dailyLogId', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects a request with no auth token', async () => {
        const res = await request(app).get('/api/root-causes/1');
        expect(res.status).toBe(401);
    });

    it('rejects an NGO role (RBAC unaffected by the ownership fix)', async () => {
        const kitchen = await registerKitchen();
        const log = await createDailyLog(kitchen.token);
        const ngo = await registerNgo();

        const res = await request(app)
            .get(`/api/root-causes/${log.id}`)
            .set('Authorization', `Bearer ${ngo.token}`);
        expect(res.status).toBe(403);
    });

    it("blocks a kitchen from inspecting another kitchen's daily log", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const log = await createDailyLog(kitchenA.token);

        const res = await request(app)
            .get(`/api/root-causes/${log.id}`)
            .set('Authorization', `Bearer ${kitchenB.token}`);
        expect(res.status).toBe(403);
    });

    it('returns 404 for a daily log that does not exist', async () => {
        const kitchen = await registerKitchen();

        const res = await request(app)
            .get('/api/root-causes/999999')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(404);
    });

    it('lets the owning kitchen fetch its own root cause analysis', async () => {
        const kitchen = await registerKitchen();
        const log = await createDailyLog(kitchen.token);

        const res = await request(app)
            .get(`/api/root-causes/${log.id}`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data).toHaveProperty('cause');
    });
});
