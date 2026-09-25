const request = require('supertest');
const {
    app,
    pool,
    resetDb,
    registerKitchen,
    registerNgo,
    verifyNgo,
    createSystemAdmin,
} = require('./testHelpers');

async function createListing(kitchenToken) {
    const res = await request(app)
        .post('/api/surplus-listings')
        .set('Authorization', `Bearer ${kitchenToken}`)
        .send({
            quantity: 10,
            foodType: 'Rice',
            safeUntilTime: new Date(Date.now() + 3600 * 1000).toISOString(),
        });
    return res.body.listing;
}

describe('GET /api/surplus-listings/:id/ngo-matches', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects a request with no auth token', async () => {
        const res = await request(app).get('/api/surplus-listings/1/ngo-matches');
        expect(res.status).toBe(401);
    });

    it('blocks an NGO from viewing ranked matches for a listing', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const ngo = await registerNgo();

        const res = await request(app)
            .get(`/api/surplus-listings/${listing.id}/ngo-matches`)
            .set('Authorization', `Bearer ${ngo.token}`);
        expect(res.status).toBe(403);
    });

    it("blocks a kitchen from viewing matches for another kitchen's listing", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const listing = await createListing(kitchenA.token);

        const res = await request(app)
            .get(`/api/surplus-listings/${listing.id}/ngo-matches`)
            .set('Authorization', `Bearer ${kitchenB.token}`);
        expect(res.status).toBe(403);
    });

    it('lets the owning kitchen view ranked NGO matches', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);

        const ngo = await registerNgo();
        const { token: adminToken } = await createSystemAdmin();
        await verifyNgo(ngo.organization.id, adminToken);

        const res = await request(app)
            .get(`/api/surplus-listings/${listing.id}/ngo-matches`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.matches)).toBe(true);
        expect(res.body.matches.some((m) => m.ngoOrgId === ngo.organization.id)).toBe(true);
        expect(res.body.matches[0]).toHaveProperty('matchScore');
        expect(res.body.matches[0]).toHaveProperty('matchLevel');
        expect(res.body.matches[0]).toHaveProperty('reason');
    });

    it('lets a SYSTEM_ADMIN view ranked NGO matches for any listing', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const { token: adminToken } = await createSystemAdmin();

        const res = await request(app)
            .get(`/api/surplus-listings/${listing.id}/ngo-matches`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
    });

    it('ranks a nearer, better-fitting, in-category NGO above a distant, mismatched one', async () => {
        const kitchen = await registerKitchen({ extra: { latitude: 12.9, longitude: 77.6 } });

        const closeGoodNgo = await registerNgo({
            extra: { latitude: 12.91, longitude: 77.61 },
        });
        const farBadNgo = await registerNgo({
            extra: { latitude: 20.0, longitude: 85.0 },
        });
        const { token: adminToken } = await createSystemAdmin();
        await verifyNgo(closeGoodNgo.organization.id, adminToken);
        await verifyNgo(farBadNgo.organization.id, adminToken);

        await request(app)
            .patch('/api/organizations/me')
            .set('Authorization', `Bearer ${closeGoodNgo.token}`)
            .send({ capacity_kg: 25, preferred_food_types: ['Rice'] });
        await request(app)
            .patch('/api/organizations/me')
            .set('Authorization', `Bearer ${farBadNgo.token}`)
            .send({ capacity_kg: 1, preferred_food_types: ['Fruits'] });

        const listing = await createListing(kitchen.token);

        const res = await request(app)
            .get(`/api/surplus-listings/${listing.id}/ngo-matches`)
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.status).toBe(200);
        const ids = res.body.matches.map((m) => m.ngoOrgId);
        expect(ids.indexOf(closeGoodNgo.organization.id)).toBeLessThan(ids.indexOf(farBadNgo.organization.id));
    });

    it('rejects matching against a listing that is no longer Available', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const ngo = await registerNgo();
        const { token: adminToken } = await createSystemAdmin();
        await verifyNgo(ngo.organization.id, adminToken);

        await request(app)
            .post(`/api/surplus-listings/${listing.id}/claim`)
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });

        const res = await request(app)
            .get(`/api/surplus-listings/${listing.id}/ngo-matches`)
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(409);
    });

    it('returns 404 for a nonexistent listing', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .get('/api/surplus-listings/999999/ngo-matches')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(res.status).toBe(404);
    });
});
