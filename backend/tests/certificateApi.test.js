const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');

const A = (token) => ({ Authorization: `Bearer ${token}` });

async function setupVerifiedNgo(overrides) {
    const ngo = await registerNgo(overrides);
    const { token: adminToken } = await createSystemAdmin();
    await verifyNgo(ngo.organization.id, adminToken);
    return ngo;
}

async function createMenuItem(kitchenToken, overrides = {}) {
    const res = await request(app)
        .post('/api/menu-items')
        .set(A(kitchenToken))
        .send({ name: overrides.name || 'Veg Thali', unit: 'kg', costPerUnit: overrides.costPerUnit ?? 40, preparationCostPerUnit: overrides.preparationCostPerUnit ?? 10 });
    expect(res.status).toBe(201);
    return res.body.menuItem;
}

async function createDailyLog(kitchenToken, menuItemId, overrides = {}) {
    const { localDateString } = require('./testHelpers');
    const res = await request(app)
        .post('/api/daily-logs')
        .set(A(kitchenToken))
        .send({
            menuItemId,
            logDate: overrides.logDate || localDateString(),
            mealSlot: 'LUNCH',
            quantityPrepared: 20,
            quantityLeftover: overrides.quantityLeftover ?? 10,
        });
    expect(res.status).toBe(201);
    return res.body.log;
}

async function createListing(kitchenToken, overrides = {}) {
    const res = await request(app)
        .post('/api/surplus-listings')
        .set(A(kitchenToken))
        .send({
            dailyLogId: overrides.dailyLogId,
            quantity: overrides.quantity ?? 8,
            foodType: overrides.foodType || 'Rice and Curry',
            safeUntilTime: overrides.safeUntilTime || new Date(Date.now() + 3600 * 1000).toISOString(),
        });
    expect(res.status).toBe(201);
    return res.body.listing;
}

async function claimListing(ngoToken, listingId) {
    const res = await request(app)
        .post(`/api/surplus-listings/${listingId}/claim`)
        .set(A(ngoToken))
        .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });
    expect(res.status).toBe(200);
    return res.body.listing;
}

async function confirmPickup(kitchenToken, listingId) {
    const res = await request(app)
        .patch(`/api/surplus-listings/${listingId}/confirm-pickup`)
        .set(A(kitchenToken))
        .send({ confirmedPickupTime: new Date(Date.now() + 2000 * 1000).toISOString() });
    expect(res.status).toBe(200);
    return res.body.listing;
}

async function collect(actorToken, listingId, quantityCollected) {
    const res = await request(app)
        .patch(`/api/surplus-listings/${listingId}/collect`)
        .set(A(actorToken))
        .send({ quantityCollected });
    expect(res.status).toBe(200);
    return res.body.listing;
}

async function runFullLifecycleWithLog(kitchen, ngo, { costPerUnit = 40, preparationCostPerUnit = 10, quantity = 8 } = {}) {
    const menuItem = await createMenuItem(kitchen.token, { costPerUnit, preparationCostPerUnit });
    const log = await createDailyLog(kitchen.token, menuItem.id, { quantityLeftover: quantity });
    const listing = await createListing(kitchen.token, { dailyLogId: log.id, quantity });
    await claimListing(ngo.token, listing.id);
    await confirmPickup(kitchen.token, listing.id);
    await collect(kitchen.token, listing.id, quantity);
    return { listing, menuItem, log };
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('Impact certificate - blocked before collection', () => {
    it('refuses a certificate for a listing that is still Available', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(kitchen.token));
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/collected/i);
    });

    it('refuses a certificate for a listing that is only Claimed, not yet Collected', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await claimListing(ngo.token, listing.id);

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(kitchen.token));
        expect(res.status).toBe(409);
    });
});

describe('Impact certificate - a collected donation', () => {
    it('issues a certificate using real stored financial and environmental values', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const { listing } = await runFullLifecycleWithLog(kitchen, ngo, { costPerUnit: 40, preparationCostPerUnit: 10, quantity: 8 });

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(kitchen.token));
        expect(res.status).toBe(200);

        const cert = res.body.data;
        expect(cert.listingId).toBe(listing.id);
        expect(typeof cert.certificateId).toBe('string');
        expect(cert.certificateId.length).toBeGreaterThan(0);
        expect(cert.quantityCollected).toBe(8);
        expect(cert.donorOrganization.name).toBe(kitchen.organization.name);
        expect(cert.receivingOrganization.name).toBe(ngo.organization.name);

        // 8 kg * (40 + 10) per kg = 400
        expect(cert.financialImpact).toMatchObject({ available: true, valueInr: 400 });
        // 8 kg * 2.5 co2e/kg = 20; 8 / 0.4 = 20 meal equivalents - same factors as ai/financialIntelligence.js
        expect(cert.environmentalImpact.co2eAvoidedKg).toBe(20);
        expect(cert.environmentalImpact.mealEquivalents).toBe(20);

        expect(cert.ledgerVerification.valid).toBe(true);
        expect(cert.ledgerVerification.eventCount).toBe(4);
        expect(cert.disclaimer).toMatch(/prototype/i);
        expect(cert.disclaimer).toMatch(/not a legal/i);
    });

    it('reports financial impact as unavailable (never invented) when the listing has no linked daily log', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token); // no dailyLogId
        await claimListing(ngo.token, listing.id);
        await confirmPickup(kitchen.token, listing.id);
        await collect(kitchen.token, listing.id, listing.quantity);

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data.financialImpact).toEqual({ available: false });
        // Environmental impact is derived purely from the collected quantity, so it is still available.
        expect(res.body.data.environmentalImpact.co2eAvoidedKg).toBeGreaterThan(0);
    });

    it('the claiming NGO can also fetch the certificate', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const { listing } = await runFullLifecycleWithLog(kitchen, ngo);

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(ngo.token));
        expect(res.status).toBe(200);
        expect(res.body.data.listingId).toBe(listing.id);
    });

    it('the same donation always yields the same certificate id (deterministic, not a fresh random one)', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const { listing } = await runFullLifecycleWithLog(kitchen, ngo);

        const first = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(kitchen.token));
        const second = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(kitchen.token));
        expect(first.body.data.certificateId).toBe(second.body.data.certificateId);
    });
});

describe('Impact certificate - security', () => {
    it('requires authentication', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const { listing } = await runFullLifecycleWithLog(kitchen, ngo);

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`);
        expect(res.status).toBe(401);
    });

    it('refuses an organization uninvolved in the donation, and leaks nothing about it', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const outsider = await registerKitchen({ organizationName: 'Outsider Kitchen' });
        const { listing } = await runFullLifecycleWithLog(kitchen, ngo, { foodType: 'Confidential Recipe' });

        const res = await request(app).get(`/api/donations/${listing.id}/certificate`).set(A(outsider.token));
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toMatch(/Confidential Recipe/);
    });

    it('never trusts a client-supplied organizationId to spoof access to someone else\'s certificate', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const outsider = await registerKitchen({ organizationName: 'Outsider Kitchen 2' });
        const { listing } = await runFullLifecycleWithLog(kitchen, ngo);

        const res = await request(app)
            .get(`/api/donations/${listing.id}/certificate`)
            .set(A(outsider.token))
            .send({ organizationId: kitchen.organization.id });
        expect(res.status).toBe(403);
    });

    it('returns 404 for a nonexistent listing id', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app).get('/api/donations/999999999/certificate').set(A(kitchen.token));
        expect(res.status).toBe(404);
    });
});
