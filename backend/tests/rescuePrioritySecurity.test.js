const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');

// Auth coverage for GET /api/rescue-priorities using a real database and real JWTs. Since the security audit
// (Task 7) the route is NGO-facing like the surplus feed: verified NGOs and system admins only. See
// securityAudit.test.js for the cross-organization and service-area regression tests.

describe('Rescue Priority route - authentication middleware consolidation', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects a request with no token', async () => {
        const res = await request(app).get('/api/rescue-priorities');
        expect(res.status).toBe(401);
    });

    it('rejects a request with an invalid/garbage token', async () => {
        const res = await request(app)
            .get('/api/rescue-priorities')
            .set('Authorization', 'Bearer not-a-real-jwt');
        expect(res.status).toBe(401);
    });

    it('rejects a deactivated user even with a previously-valid token', async () => {
        const ngo = await registerNgo();
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [ngo.user.id]);

        const res = await request(app)
            .get('/api/rescue-priorities')
            .set('Authorization', `Bearer ${ngo.token}`);
        expect(res.status).toBe(401);
    });

    it('allows a verified NGO_ADMIN', async () => {
        const ngo = await registerNgo();
        const admin = await createSystemAdmin();
        await verifyNgo(ngo.organization.id, admin.token);
        const res = await request(app)
            .get('/api/rescue-priorities')
            .set('Authorization', `Bearer ${ngo.token}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('allows a SYSTEM_ADMIN', async () => {
        const admin = await createSystemAdmin();
        const res = await request(app).get('/api/rescue-priorities').set('Authorization', `Bearer ${admin.token}`);
        expect(res.status).toBe(200);
    });

    it('refuses an NGO that is still pending verification, like the surplus feed', async () => {
        const ngo = await registerNgo();
        const res = await request(app)
            .get('/api/rescue-priorities')
            .set('Authorization', `Bearer ${ngo.token}`);
        expect(res.status).toBe(403);
    });

    it('refuses a KITCHEN_MANAGER: kitchens must not see other kitchens listings', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .get('/api/rescue-priorities')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(403);
    });
});
