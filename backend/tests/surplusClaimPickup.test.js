const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');

async function setupVerifiedNgo() {
    const ngo = await registerNgo();
    const { token: adminToken } = await createSystemAdmin();
    await verifyNgo(ngo.organization.id, adminToken);
    return ngo;
}

async function createListing(kitchenToken, overrides = {}) {
    const res = await request(app)
        .post('/api/surplus-listings')
        .set('Authorization', `Bearer ${kitchenToken}`)
        .send({
            quantity: overrides.quantity ?? 8,
            foodType: overrides.foodType || 'Rice and Curry',
            safeUntilTime: overrides.safeUntilTime || new Date(Date.now() + 3600 * 1000).toISOString(),
        });
    return res;
}

describe('Surplus listing claim + pickup workflow', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects a listing with a non-positive quantity', async () => {
        const kitchen = await registerKitchen();
        const res = await createListing(kitchen.token, { quantity: 0 });
        expect(res.status).toBe(400);
    });

    it('rejects a listing with a safe-until time in the past', async () => {
        const kitchen = await registerKitchen();
        const res = await createListing(kitchen.token, {
            safeUntilTime: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        expect(res.status).toBe(400);
    });

    it('shows a posted listing in the verified NGO feed', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();

        const listingRes = await createListing(kitchen.token);
        expect(listingRes.status).toBe(201);

        const feedRes = await request(app)
            .get('/api/surplus-listings/feed')
            .set('Authorization', `Bearer ${ngo.token}`);

        expect(feedRes.status).toBe(200);
        expect(feedRes.body.listings.some((l) => l.id === listingRes.body.listing.id)).toBe(true);
    });

    it('lets a verified NGO claim an available listing and notifies the kitchen', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listingRes = await createListing(kitchen.token);

        const claimRes = await request(app)
            .post(`/api/surplus-listings/${listingRes.body.listing.id}/claim`)
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });

        expect(claimRes.status).toBe(200);
        expect(claimRes.body.listing.status).toBe('Claimed');
        expect(claimRes.body.listing.claimed_by_ngo_id).toBe(ngo.organization.id);

        const notifRes = await request(app)
            .get('/api/notifications')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(notifRes.body.notifications.some((n) => n.type === 'LISTING_CLAIMED')).toBe(true);
    });

    it('enforces first-claim-wins: a second NGO cannot claim an already-claimed listing', async () => {
        const kitchen = await registerKitchen();
        const ngoA = await setupVerifiedNgo();
        const ngoB = await setupVerifiedNgo();
        const listingRes = await createListing(kitchen.token);

        const claimA = await request(app)
            .post(`/api/surplus-listings/${listingRes.body.listing.id}/claim`)
            .set('Authorization', `Bearer ${ngoA.token}`)
            .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });
        const claimB = await request(app)
            .post(`/api/surplus-listings/${listingRes.body.listing.id}/claim`)
            .set('Authorization', `Bearer ${ngoB.token}`)
            .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });

        expect(claimA.status).toBe(200);
        expect(claimB.status).toBe(409);
    });

    it('runs the full claim -> confirm pickup -> collect lifecycle', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listingRes = await createListing(kitchen.token);
        const listingId = listingRes.body.listing.id;

        const claimRes = await request(app)
            .post(`/api/surplus-listings/${listingId}/claim`)
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });
        expect(claimRes.body.listing.status).toBe('Claimed');

        const confirmRes = await request(app)
            .patch(`/api/surplus-listings/${listingId}/confirm-pickup`)
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ confirmedPickupTime: new Date(Date.now() + 2000 * 1000).toISOString() });
        expect(confirmRes.status).toBe(200);
        expect(confirmRes.body.listing.confirmed_pickup_time).not.toBeNull();

        const collectRes = await request(app)
            .patch(`/api/surplus-listings/${listingId}/collect`)
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ quantityCollected: 8 });
        expect(collectRes.status).toBe(200);
        expect(collectRes.body.listing.status).toBe('Collected');

        const notifRes = await request(app)
            .get('/api/notifications')
            .set('Authorization', `Bearer ${kitchen.token}`);
        expect(notifRes.body.notifications.some((n) => n.type === 'LISTING_COLLECTED')).toBe(true);
    });

    it('rejects collecting a listing that has not been claimed', async () => {
        const kitchen = await registerKitchen();
        const listingRes = await createListing(kitchen.token);

        const res = await request(app)
            .patch(`/api/surplus-listings/${listingRes.body.listing.id}/collect`)
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({ quantityCollected: 8 });

        expect(res.status).toBe(409);
    });
});
