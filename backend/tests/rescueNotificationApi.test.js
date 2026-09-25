const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');
const rescueNotificationService = require('../src/services/rescueNotificationService');

const A = (token) => ({ Authorization: `Bearer ${token}` });
const notify = (token, listingId, body = {}) => request(app).post(`/api/communications/rescue/${listingId}/notify`).set(A(token)).send(body);

async function registerKitchenAt(latitude, longitude, organizationName) {
    return registerKitchen({ organizationName, extra: { latitude, longitude } });
}

async function setupVerifiedNgoAt(latitude, longitude, organizationName, extra = {}) {
    const ngo = await registerNgo({ organizationName, extra: { latitude, longitude, ...extra } });
    const { token: adminToken } = await createSystemAdmin();
    await verifyNgo(ngo.organization.id, adminToken);
    return ngo;
}

async function createListing(kitchenToken, overrides = {}) {
    const res = await request(app)
        .post('/api/surplus-listings')
        .set(A(kitchenToken))
        .send({
            quantity: overrides.quantity ?? 5,
            foodType: overrides.foodType || 'Rice',
            safeUntilTime: overrides.safeUntilTime || new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        });
    expect(res.status).toBe(201);
    return res.body.listing;
}

async function claim(ngoToken, listingId) {
    const res = await request(app)
        .post(`/api/surplus-listings/${listingId}/claim`)
        .set(A(ngoToken))
        .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });
    expect(res.status).toBe(200);
    return res.body.listing;
}

async function notificationsFor(token) {
    const res = await request(app).get('/api/notifications').set(A(token));
    expect(res.status).toBe(200);
    return res.body.notifications;
}

beforeEach(async () => {
    await resetDb();
    rescueNotificationService.resetCooldowns();
});

afterAll(async () => {
    await pool.end();
});

describe('POST /api/communications/rescue/:listingId/notify - authentication and role', () => {
    it('requires a token', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Auth');
        const listing = await createListing(kitchen.token);
        const res = await request(app).post(`/api/communications/rescue/${listing.id}/notify`).send({});
        expect(res.status).toBe(401);
    });

    it('rejects a garbage token', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Auth2');
        const listing = await createListing(kitchen.token);
        const res = await notify('not-a-real-jwt', listing.id);
        expect(res.status).toBe(401);
    });

    it('refuses an NGO role (kitchen-only endpoint)', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Role');
        const ngo = await setupVerifiedNgoAt(0.01, 0, 'N Role');
        const listing = await createListing(kitchen.token);
        const res = await notify(ngo.token, listing.id);
        expect(res.status).toBe(403);
    });

    it('allows the owning kitchen', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Owner');
        await setupVerifiedNgoAt(0.01, 0, 'N Owner');
        const listing = await createListing(kitchen.token);
        const res = await notify(kitchen.token, listing.id);
        expect(res.status).toBe(200);
    });
});

describe('POST /api/communications/rescue/:listingId/notify - ownership and listing state', () => {
    it('refuses a kitchen that does not own the listing', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Foreign Owner');
        const outsider = await registerKitchenAt(0, 0, 'K Outsider');
        const listing = await createListing(kitchen.token);

        const res = await notify(outsider.token, listing.id);
        expect(res.status).toBe(403);
    });

    it('returns 404 for a nonexistent listing', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Nonexistent');
        const res = await notify(kitchen.token, 999999999);
        expect(res.status).toBe(404);
    });

    it('refuses a listing that is no longer Available (already claimed)', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Claimed State');
        const ngo = await setupVerifiedNgoAt(0.01, 0, 'N Claimed State');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        const res = await notify(kitchen.token, listing.id);
        expect(res.status).toBe(409);
    });
});

describe('POST /api/communications/rescue/:listingId/notify - matched recipients only', () => {
    it('notifies only NGOs the existing ranking considers a good match, not every NGO indiscriminately', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Matching');
        const close = await setupVerifiedNgoAt(0.01, 0, 'NGO Close'); // ~1km, no radius limit -> in range, high match score
        // Far away AND has configured a small service radius of its own, so the existing radius rule excludes
        // it from candidates entirely - the same rule the original "surplus posted" notification already uses.
        const far = await setupVerifiedNgoAt(10, 10, 'NGO Far', { serviceRadiusKm: 5 });

        const listing = await createListing(kitchen.token);
        const res = await notify(kitchen.token, listing.id);

        expect(res.status).toBe(200);
        const notifiedOrgIds = res.body.data.results.map((r) => r.organizationId);
        expect(notifiedOrgIds).toContain(close.organization.id);
        expect(notifiedOrgIds).not.toContain(far.organization.id);

        const farNotifications = await notificationsFor(far.token);
        expect(farNotifications.filter((n) => n.type === 'SURPLUS_POSTED')).toHaveLength(0);

        const closeNotifications = await notificationsFor(close.token);
        expect(closeNotifications.filter((n) => n.type === 'SURPLUS_POSTED').length).toBeGreaterThan(0);
    });

    it('reports zero recipients (not an error) when no NGO is a good enough match', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K NoMatch');
        // No verified NGOs at all - the ranking naturally returns nothing to notify.
        const listing = await createListing(kitchen.token);

        const res = await notify(kitchen.token, listing.id);
        expect(res.status).toBe(200);
        expect(res.body.data.recipientCount).toBe(0);
        expect(res.body.data.results).toEqual([]);
    });
});

describe('POST /api/communications/rescue/:listingId/notify - response shape and mock delivery', () => {
    it('reports the provider, recipient count and per-recipient delivery outcome', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Shape');
        await setupVerifiedNgoAt(0.01, 0, 'N Shape');
        const listing = await createListing(kitchen.token);

        const res = await notify(kitchen.token, listing.id);
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data.provider).toBe('mock');
        expect(data.communicationEnabled).toBe(true);
        expect(data.recipientCount).toBe(1);
        expect(data.results).toHaveLength(1);
        const [result] = data.results;
        expect(result.matchLevel).toMatch(/EXCELLENT|GOOD/);
        expect(result.accepted).toBe(true);
        expect(result.messagesSent).toBeGreaterThan(0);
        expect(Array.isArray(result.deliveries)).toBe(true);
        expect(result.deliveries[0].provider).toBe('mock');
        expect(typeof result.deliveries[0].messageId).toBe('string');
    });
});

describe('POST /api/communications/rescue/:listingId/notify - client input is never trusted', () => {
    it('ignores a client-supplied organizationId/ngoId/quantity/urgency in the request body', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Spoof');
        const realNgo = await setupVerifiedNgoAt(0.01, 0, 'N Real');
        const spoofedNgo = await setupVerifiedNgoAt(0.02, 0, 'N Spoofed Target');
        const listing = await createListing(kitchen.token, { quantity: 5 });

        const res = await notify(kitchen.token, listing.id, {
            organizationId: 999999,
            ngoId: spoofedNgo.organization.id,
            recipientOrganizationId: spoofedNgo.organization.id,
            quantity: 999999,
            urgency: 'CRITICAL',
            safeUntilTime: '2099-01-01T00:00:00.000Z',
        });

        expect(res.status).toBe(200);
        // Both NGOs are actually in range/well-matched here, so both may legitimately appear - the point is that
        // the body fields had no special effect (no crash, no different targeting, no altered quantity/urgency).
        const notifiedOrgIds = res.body.data.results.map((r) => r.organizationId);
        expect(notifiedOrgIds).toContain(realNgo.organization.id);
    });
});

describe('POST /api/communications/rescue/:listingId/notify - duplicate-send protection', () => {
    it('refuses a second notify request for the same listing within the cooldown window', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Cooldown');
        await setupVerifiedNgoAt(0.01, 0, 'N Cooldown');
        const listing = await createListing(kitchen.token);

        const first = await notify(kitchen.token, listing.id);
        expect(first.status).toBe(200);

        const second = await notify(kitchen.token, listing.id);
        expect(second.status).toBe(429);
    });

    it('does not create duplicate in-app notifications from the refused second attempt', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Cooldown2');
        const ngo = await setupVerifiedNgoAt(0.01, 0, 'N Cooldown2');
        const listing = await createListing(kitchen.token);

        await notify(kitchen.token, listing.id);
        const afterFirst = await notificationsFor(ngo.token);

        await notify(kitchen.token, listing.id); // refused
        const afterSecond = await notificationsFor(ngo.token);

        expect(afterSecond.length).toBe(afterFirst.length);
    });
});

describe('POST /api/communications/rescue/:listingId/notify - communication disabled', () => {
    it('still succeeds and creates the in-app notification, but reports accepted:false deliveries', async () => {
        const saved = process.env.COMMUNICATION_ENABLED;
        process.env.COMMUNICATION_ENABLED = 'false';
        let freshService;
        let freshPool;
        jest.isolateModules(() => {
            freshService = require('../src/services/rescueNotificationService');
            freshPool = require('../src/models/db'); // isolateModules creates a brand new pg Pool - must close it below
        });
        process.env.COMMUNICATION_ENABLED = saved;

        try {
            const kitchen = await registerKitchenAt(0, 0, 'K Disabled');
            const ngo = await setupVerifiedNgoAt(0.01, 0, 'N Disabled');
            const listing = await createListing(kitchen.token);
            const kitchenUser = { id: kitchen.user.id, organizationId: kitchen.organization.id, role: kitchen.user.role };

            const data = await freshService.notifyMatchedNgos(kitchenUser, listing.id);
            expect(data.communicationEnabled).toBe(false);
            expect(data.results[0].accepted).toBe(false);
            expect(data.results[0].deliveries[0].disabled).toBe(true);

            // The in-app notification (the real source of truth) was still created despite communication being off.
            const notifications = await notificationsFor(ngo.token);
            expect(notifications.filter((n) => n.type === 'SURPLUS_POSTED').length).toBeGreaterThan(0);
        } finally {
            await freshPool.end();
        }
    });
});

describe('POST /api/communications/rescue/:listingId/notify - regression', () => {
    it('does not affect the existing claim -> pickup -> collect lifecycle', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Regression');
        const ngo = await setupVerifiedNgoAt(0.01, 0, 'N Regression');
        const listing = await createListing(kitchen.token);

        await notify(kitchen.token, listing.id);

        const claimed = await claim(ngo.token, listing.id);
        expect(claimed.status).toBe('Claimed');

        const confirmRes = await request(app)
            .patch(`/api/surplus-listings/${listing.id}/confirm-pickup`)
            .set(A(kitchen.token))
            .send({ confirmedPickupTime: new Date(Date.now() + 2000 * 1000).toISOString() });
        expect(confirmRes.status).toBe(200);

        const collectRes = await request(app)
            .patch(`/api/surplus-listings/${listing.id}/collect`)
            .set(A(kitchen.token))
            .send({ quantityCollected: listing.quantity });
        expect(collectRes.status).toBe(200);
        expect(collectRes.body.listing.status).toBe('Collected');
    });

    it('the donation ledger for the listing still records exactly SURPLUS_CREATED and SURPLUS_CLAIMED after a notify + claim', async () => {
        const kitchen = await registerKitchenAt(0, 0, 'K Ledger Regression');
        const ngo = await setupVerifiedNgoAt(0.01, 0, 'N Ledger Regression');
        const listing = await createListing(kitchen.token);

        await notify(kitchen.token, listing.id);
        await claim(ngo.token, listing.id);

        const ledgerRes = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(kitchen.token));
        expect(ledgerRes.status).toBe(200);
        expect(ledgerRes.body.data.events.map((e) => e.eventType)).toEqual(['SURPLUS_CREATED', 'SURPLUS_CLAIMED']);
    });
});
