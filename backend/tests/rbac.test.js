const request = require('supertest');
const {
    app,
    pool,
    resetDb,
    registerKitchen,
    registerNgo,
    createSystemAdmin,
} = require('./testHelpers');

describe('Role-based access control', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('blocks an NGO_ADMIN from creating a menu item', async () => {
        const ngo = await registerNgo();
        const res = await request(app)
            .post('/api/menu-items')
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ name: 'Rice', unit: 'kg' });
        expect(res.status).toBe(403);
    });

    it('blocks a KITCHEN_MANAGER from viewing the NGO surplus feed', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .get('/api/surplus-listings/feed')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(403);
    });

    it('blocks a non-SYSTEM_ADMIN from accessing the NGO verification queue', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .get('/api/organizations/pending-ngos')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(403);
    });

    it('blocks a non-SYSTEM_ADMIN from verifying an NGO', async () => {
        const ngo = await registerNgo();
        const kitchen = await registerKitchen();
        const res = await request(app)
            .patch(`/api/organizations/${ngo.organization.id}/verify`)
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ verificationStatus: 'verified' });
        expect(res.status).toBe(403);
    });

    it('allows a SYSTEM_ADMIN to access the NGO verification queue', async () => {
        await registerNgo();
        const { token } = await createSystemAdmin();
        const res = await request(app)
            .get('/api/organizations/pending-ngos')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.organizations)).toBe(true);
    });

    it('blocks an unverified NGO from claiming a surplus listing', async () => {
        const kitchen = await registerKitchen();
        const ngo = await registerNgo(); // never verified

        const menuItemRes = await request(app)
            .post('/api/menu-items')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ name: 'Dal', unit: 'kg' });

        const listingRes = await request(app)
            .post('/api/surplus-listings')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                quantity: 5,
                foodType: 'Dal',
                safeUntilTime: new Date(Date.now() + 3600 * 1000).toISOString(),
            });

        expect(menuItemRes.status).toBe(201);
        expect(listingRes.status).toBe(201);

        const claimRes = await request(app)
            .post(`/api/surplus-listings/${listingRes.body.listing.id}/claim`)
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });

        expect(claimRes.status).toBe(403);
    });

    it('scopes daily logs strictly to the requesting organization', async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();

        const menuItemRes = await request(app)
            .post('/api/menu-items')
            .set('Authorization', `Bearer ${kitchenA.token}`)
            .send({ name: 'Sambar', unit: 'liters' });

        const logRes = await request(app)
            .post('/api/daily-logs')
            .set('Authorization', `Bearer ${kitchenA.token}`)
            .send({
                menuItemId: menuItemRes.body.menuItem.id,
                logDate: new Date().toISOString().slice(0, 10),
                mealSlot: 'LUNCH',
                quantityPrepared: 10,
            });
        expect(logRes.status).toBe(201);

        // Kitchen B must not be able to read Kitchen A's log by guessing its id.
        const getRes = await request(app)
            .get(`/api/daily-logs/${logRes.body.log.id}`)
            .set('Authorization', `Bearer ${kitchenB.token}`);
        expect(getRes.status).toBe(403);
    });
});
