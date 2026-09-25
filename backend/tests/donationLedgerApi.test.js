const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');

const A = (token) => ({ Authorization: `Bearer ${token}` });

async function setupVerifiedNgo(overrides) {
    const ngo = await registerNgo(overrides);
    const { token: adminToken } = await createSystemAdmin();
    await verifyNgo(ngo.organization.id, adminToken);
    return ngo;
}

async function createListing(kitchenToken, overrides = {}) {
    const res = await request(app)
        .post('/api/surplus-listings')
        .set(A(kitchenToken))
        .send({
            quantity: overrides.quantity ?? 8,
            foodType: overrides.foodType || 'Rice and Curry',
            safeUntilTime: overrides.safeUntilTime || new Date(Date.now() + 3600 * 1000).toISOString(),
        });
    return res.body.listing;
}

async function claimListing(ngoToken, listingId) {
    const res = await request(app)
        .post(`/api/surplus-listings/${listingId}/claim`)
        .set(A(ngoToken))
        .send({ proposedPickupTime: new Date(Date.now() + 1800 * 1000).toISOString() });
    return res;
}

async function confirmPickup(kitchenToken, listingId) {
    return request(app)
        .patch(`/api/surplus-listings/${listingId}/confirm-pickup`)
        .set(A(kitchenToken))
        .send({ confirmedPickupTime: new Date(Date.now() + 2000 * 1000).toISOString() });
}

async function collect(actorToken, listingId, quantityCollected = 8) {
    return request(app)
        .patch(`/api/surplus-listings/${listingId}/collect`)
        .set(A(actorToken))
        .send({ quantityCollected });
}

async function runFullLifecycle(kitchen, ngo, listing) {
    await claimListing(ngo.token, listing.id);
    await confirmPickup(kitchen.token, listing.id);
    return collect(kitchen.token, listing.id, listing.quantity);
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('Donation ledger - authentication', () => {
    it('requires a token for the ledger, verify and certificate endpoints', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);

        expect((await request(app).get(`/api/donations/${listing.id}/ledger`)).status).toBe(401);
        expect((await request(app).get(`/api/donations/${listing.id}/ledger/verify`)).status).toBe(401);
        expect((await request(app).get(`/api/donations/${listing.id}/certificate`)).status).toBe(401);
    });

    it('rejects a garbage token', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A('not-a-real-jwt'));
        expect(res.status).toBe(401);
    });
});

describe('Donation ledger - first entry and genesis hash', () => {
    it('creating a listing appends exactly one SURPLUS_CREATED entry, chained from the genesis hash', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data.eventCount).toBe(1);
        expect(res.body.data.events).toHaveLength(1);

        const first = res.body.data.events[0];
        expect(first.eventType).toBe('SURPLUS_CREATED');
        expect(first.sequenceNumber).toBe(1);
        expect(first.previousHash).toBe('0'.repeat(64));
        expect(first.entryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(res.body.data.firstHash).toBe(first.entryHash);
        expect(res.body.data.lastHash).toBe(first.entryHash);
        expect(res.body.data.chainVerification.valid).toBe(true);
    });
});

describe('Donation ledger - second entry links to the first', () => {
    it('claiming the listing appends a SURPLUS_CLAIMED entry whose previousHash equals the first entry\'s hash', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await claimListing(ngo.token, listing.id);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(kitchen.token));
        const [created, claimed] = res.body.data.events;
        expect(res.body.data.eventCount).toBe(2);
        expect(claimed.eventType).toBe('SURPLUS_CLAIMED');
        expect(claimed.sequenceNumber).toBe(2);
        expect(claimed.previousHash).toBe(created.entryHash);
    });
});

describe('Donation ledger - full lifecycle and event ordering', () => {
    it('a complete create -> claim -> confirm -> collect lifecycle produces exactly the 4 expected entries, in order', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);

        const collectRes = await runFullLifecycle(kitchen, ngo, listing);
        expect(collectRes.status).toBe(200);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(kitchen.token));
        const eventTypes = res.body.data.events.map((e) => e.eventType);
        expect(eventTypes).toEqual(['SURPLUS_CREATED', 'SURPLUS_CLAIMED', 'PICKUP_CONFIRMED', 'SURPLUS_COLLECTED']);
        expect(res.body.data.events.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4]);
        expect(res.body.data.chainVerification.valid).toBe(true);
        expect(res.body.data.chainVerification.eventCount).toBe(4);
    });

    it('the claiming NGO can also read the ledger once it has claimed the listing', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await claimListing(ngo.token, listing.id);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(ngo.token));
        expect(res.status).toBe(200);
        expect(res.body.data.eventCount).toBe(2);
    });
});

describe('Donation ledger - hash verification endpoint', () => {
    it('returns valid: true with the documented shape for a genuine, untampered chain', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await runFullLifecycle(kitchen, ngo, listing);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger/verify`).set(A(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ valid: true, eventCount: 4 });
        expect(typeof res.body.data.verifiedAt).toBe('string');
        expect(res.body.data.firstHash).toMatch(/^[0-9a-f]{64}$/);
        expect(res.body.data.lastHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('detects a tampered ledger entry (payload altered directly in the database)', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);

        await pool.query(
            `UPDATE donation_ledger_entries SET payload = '{"quantity": 999999, "foodType": "Rice and Curry"}'::jsonb
             WHERE surplus_listing_id = $1 AND event_type = 'SURPLUS_CREATED'`,
            [listing.id]
        );

        const res = await request(app).get(`/api/donations/${listing.id}/ledger/verify`).set(A(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data.valid).toBe(false);
        expect(res.body.data.brokenAtSequence).toBe(1);
        expect(res.body.data.reason).toMatch(/tampered or corrupted/i);
    });

    it('detects a broken previousHash link (an entry rewritten to point somewhere else)', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await claimListing(ngo.token, listing.id);

        await pool.query(
            `UPDATE donation_ledger_entries SET previous_hash = $1
             WHERE surplus_listing_id = $2 AND event_type = 'SURPLUS_CLAIMED'`,
            ['f'.repeat(64), listing.id]
        );

        const res = await request(app).get(`/api/donations/${listing.id}/ledger/verify`).set(A(kitchen.token));
        expect(res.body.data.valid).toBe(false);
        expect(res.body.data.brokenAtSequence).toBe(2);
        expect(res.body.data.reason).toMatch(/previousHash/);
    });
});

describe('Donation ledger - organization isolation and foreign listing access', () => {
    it('refuses (403) an organization that neither posted nor claimed the listing', async () => {
        const kitchen = await registerKitchen({ organizationName: 'Kitchen Owner' });
        const outsiderKitchen = await registerKitchen({ organizationName: 'Unrelated Kitchen' });
        const listing = await createListing(kitchen.token);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(outsiderKitchen.token));
        expect(res.status).toBe(403);
    });

    it('refuses an NGO that never claimed this particular listing', async () => {
        const kitchen = await registerKitchen();
        const uninvolvedNgo = await setupVerifiedNgo({ organizationName: 'Uninvolved NGO' });
        const listing = await createListing(kitchen.token);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(uninvolvedNgo.token));
        expect(res.status).toBe(403);
    });

    it('never leaks another organization\'s ledger content in the 403 response', async () => {
        const kitchen = await registerKitchen();
        const outsider = await registerKitchen({ organizationName: 'Outsider Kitchen' });
        const listing = await createListing(kitchen.token, { foodType: 'Secret Biryani Recipe' });

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(outsider.token));
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toMatch(/Secret Biryani Recipe/);
    });

    it('returns 404 for a listing id that does not exist at all', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app).get('/api/donations/999999999/ledger').set(A(kitchen.token));
        expect(res.status).toBe(404);
    });

    it('the verify endpoint enforces the same organization isolation', async () => {
        const kitchen = await registerKitchen();
        const outsider = await registerKitchen({ organizationName: 'Outsider Kitchen 2' });
        const listing = await createListing(kitchen.token);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger/verify`).set(A(outsider.token));
        expect(res.status).toBe(403);
    });

    it('never trusts a client-supplied organizationId to bypass the ownership check', async () => {
        const kitchen = await registerKitchen();
        const outsider = await registerKitchen({ organizationName: 'Outsider Kitchen 3' });
        const listing = await createListing(kitchen.token);

        const res = await request(app)
            .get(`/api/donations/${listing.id}/ledger?organizationId=${kitchen.organization.id}`)
            .set(A(outsider.token));
        expect(res.status).toBe(403); // the query string is simply ignored; only the token's own org matters
    });
});

describe('Donation ledger - duplicate lifecycle event protection', () => {
    it('confirming pickup twice does not create a second PICKUP_CONFIRMED entry, and the second call is refused', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await claimListing(ngo.token, listing.id);

        const first = await confirmPickup(kitchen.token, listing.id);
        expect(first.status).toBe(200);

        const second = await confirmPickup(kitchen.token, listing.id);
        expect(second.status).toBe(409);

        const res = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(kitchen.token));
        const confirmedEntries = res.body.data.events.filter((e) => e.eventType === 'PICKUP_CONFIRMED');
        expect(confirmedEntries).toHaveLength(1);
        expect(res.body.data.chainVerification.valid).toBe(true);
    });

    it('a rolled-back duplicate confirmation leaves the original confirmedPickupTime untouched', async () => {
        const kitchen = await registerKitchen();
        const ngo = await setupVerifiedNgo();
        const listing = await createListing(kitchen.token);
        await claimListing(ngo.token, listing.id);
        await confirmPickup(kitchen.token, listing.id);

        const before = await request(app).get(`/api/surplus-listings/${listing.id}`).set(A(kitchen.token));
        await confirmPickup(kitchen.token, listing.id); // refused, should change nothing
        const after = await request(app).get(`/api/surplus-listings/${listing.id}`).set(A(kitchen.token));

        expect(after.body.listing.confirmed_pickup_time).toBe(before.body.listing.confirmed_pickup_time);
    });
});
