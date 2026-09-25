const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');

const A = (token) => ({ Authorization: `Bearer ${token}` });
const URL = '/api/rescue-routes/preview';
const preview = (token, listingIds) => request(app).post(URL).set(A(token)).send({ listingIds });

async function registerKitchenAt(latitude, longitude, organizationName) {
    return registerKitchen({ organizationName, extra: { latitude, longitude } });
}

async function setupVerifiedNgoAt(latitude, longitude, organizationName) {
    const ngo = await registerNgo({ organizationName, extra: { latitude, longitude } });
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

async function confirmPickup(kitchenToken, listingId) {
    return request(app)
        .patch(`/api/surplus-listings/${listingId}/confirm-pickup`)
        .set(A(kitchenToken))
        .send({ confirmedPickupTime: new Date(Date.now() + 2000 * 1000).toISOString() });
}

async function collect(actorToken, listingId, quantityCollected) {
    return request(app)
        .patch(`/api/surplus-listings/${listingId}/collect`)
        .set(A(actorToken))
        .send({ quantityCollected });
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('POST /api/rescue-routes/preview - authentication and role restriction', () => {
    it('requires a token', async () => {
        const res = await request(app).post(URL).send({ listingIds: [1] });
        expect(res.status).toBe(401);
    });

    it('rejects a garbage token', async () => {
        const res = await preview('not-a-real-jwt', [1]);
        expect(res.status).toBe(401);
    });

    it('refuses a kitchen role (NGO-only endpoint)', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'Kitchen Only');
        const listing = await createListing(kitchen.token);
        const res = await preview(kitchen.token, [listing.id]);
        expect(res.status).toBe(403);
    });

    it('allows a verified NGO role', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K1');
        const ngo = await setupVerifiedNgoAt(18.52, 73.82, 'N1');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        const res = await preview(ngo.token, [listing.id]);
        expect(res.status).toBe(200);
    });

    it('refuses an unverified NGO', async () => {
        const ngo = await registerNgo({ organizationName: 'Unverified NGO', extra: { latitude: 18.5, longitude: 73.8 } });
        const res = await preview(ngo.token, [1]);
        expect(res.status).toBe(403);
    });
});

describe('POST /api/rescue-routes/preview - input validation', () => {
    it('rejects an empty listingIds array', async () => {
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'NGO Empty');
        const res = await preview(ngo.token, []);
        expect(res.status).toBe(400);
    });

    it('rejects a missing listingIds field', async () => {
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'NGO Missing');
        const res = await request(app).post(URL).set(A(ngo.token)).send({});
        expect(res.status).toBe(400);
    });

    it('rejects malformed (non-integer) ids', async () => {
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'NGO Malformed');
        const res = await preview(ngo.token, ['not-an-id']);
        expect(res.status).toBe(400);
    });

    it('rejects duplicate listing ids', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Dup');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Dup');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        const res = await preview(ngo.token, [listing.id, listing.id]);
        expect(res.status).toBe(400);
    });

    it('rejects more stops than the configured maximum', async () => {
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N MaxStops');
        const tooMany = Array.from({ length: 500 }, (_, i) => i + 1);
        const res = await preview(ngo.token, tooMany);
        expect(res.status).toBe(400);
    });
});

describe('POST /api/rescue-routes/preview - eligibility and organization isolation', () => {
    it('accepts a listing the NGO has claimed', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Claimed');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Claimed');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        const res = await preview(ngo.token, [listing.id]);
        expect(res.status).toBe(200);
        expect(res.body.data.stops.map((s) => s.listingId)).toEqual([listing.id]);
    });

    it('rejects an unclaimed (still Available) listing', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Unclaimed');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Unclaimed');
        const listing = await createListing(kitchen.token);

        const res = await preview(ngo.token, [listing.id]);
        expect(res.status).toBe(403);
    });

    it('rejects a listing claimed by a different NGO, without leaking anything about it', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Foreign');
        const ngoA = await setupVerifiedNgoAt(18.5, 73.8, 'NGO A');
        const ngoB = await setupVerifiedNgoAt(18.5, 73.8, 'NGO B');
        const listing = await createListing(kitchen.token, { foodType: 'Secret Stew' });
        await claim(ngoA.token, listing.id);

        const res = await preview(ngoB.token, [listing.id]);
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toMatch(/Secret Stew/);
        expect(JSON.stringify(res.body)).not.toMatch(/NGO A/);
    });

    it('rejects a collected listing', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Collected');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Collected');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);
        await confirmPickup(kitchen.token, listing.id);
        await collect(kitchen.token, listing.id, listing.quantity);

        const res = await preview(ngo.token, [listing.id]);
        expect(res.status).toBe(409);
    });

    it('handles a nonexistent listing id safely (same outcome as a foreign listing)', async () => {
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Nonexistent');
        const res = await preview(ngo.token, [999999999]);
        expect(res.status).toBe(403);
    });

    it('never trusts a client-supplied organizationId to bypass ownership', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Spoof');
        const ngoA = await setupVerifiedNgoAt(18.5, 73.8, 'NGO Spoof A');
        const ngoB = await setupVerifiedNgoAt(18.5, 73.8, 'NGO Spoof B');
        const listing = await createListing(kitchen.token);
        await claim(ngoA.token, listing.id);

        const res = await request(app)
            .post(URL)
            .set(A(ngoB.token))
            .send({ listingIds: [listing.id], organizationId: ngoA.organization.id });
        expect(res.status).toBe(403);
    });

    it('excludes a listing with no kitchen coordinates and reports a warning, without failing the whole route', async () => {
        const kitchenNoCoords = await registerKitchen({ organizationName: 'K No Coords' }); // no latitude/longitude
        const kitchenWithCoords = await registerKitchenAt(18.5, 73.8, 'K With Coords');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Partial Coords');
        const listingNoCoords = await createListing(kitchenNoCoords.token);
        const listingWithCoords = await createListing(kitchenWithCoords.token);
        await claim(ngo.token, listingNoCoords.id);
        await claim(ngo.token, listingWithCoords.id);

        const res = await preview(ngo.token, [listingNoCoords.id, listingWithCoords.id]);
        expect(res.status).toBe(200);
        expect(res.body.data.stops.map((s) => s.listingId)).toEqual([listingWithCoords.id]);
        expect(res.body.data.warnings.some((w) => w.listingId === listingNoCoords.id)).toBe(true);
    });
});

describe('POST /api/rescue-routes/preview - multi-stop route shape', () => {
    it('sequences multiple claimed listings and returns the documented response shape', async () => {
        const kitchenA = await registerKitchenAt(18.52, 73.85, 'Kitchen A');
        const kitchenB = await registerKitchenAt(18.53, 73.84, 'Kitchen B');
        const ngo = await setupVerifiedNgoAt(18.5, 73.86, 'Route NGO');

        const listingA = await createListing(kitchenA.token, { safeUntilTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString() });
        const listingB = await createListing(kitchenB.token, { safeUntilTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString() });
        await claim(ngo.token, listingA.id);
        await claim(ngo.token, listingB.id);

        const res = await preview(ngo.token, [listingA.id, listingB.id]);
        expect(res.status).toBe(200);

        const data = res.body.data;
        expect(typeof data.routeId).toBe('string');
        expect(data.origin).toEqual({ type: 'NGO', latitude: 18.5, longitude: 73.86 });
        expect(data.stops).toHaveLength(2);
        expect(data.stops[0].sequence).toBe(1);
        expect(data.stops[1].sequence).toBe(2);
        expect(typeof data.totalDistanceKm).toBe('number');
        expect(typeof data.estimatedTravelMinutes).toBe('number');
        expect(data.travelTimeType).toBe('ESTIMATED_STRAIGHT_LINE');
        expect(data.routeQuality).toBe('ESTIMATED');
        expect(Array.isArray(data.warnings)).toBe(true);
        data.stops.forEach((stop) => {
            expect(['SAFE', 'AT_RISK', 'EXPIRED_BY_ESTIMATE']).toContain(stop.timeStatus);
        });
    });

    it('falls back to FIRST_STOP origin when the NGO has no stored coordinates', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K No NGO Coord');
        const ngo = await registerNgo({ organizationName: 'NGO No Coord' }); // no latitude/longitude
        const { token: adminToken } = await createSystemAdmin();
        await verifyNgo(ngo.organization.id, adminToken);
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        const res = await preview(ngo.token, [listing.id]);
        expect(res.status).toBe(200);
        expect(res.body.data.origin.type).toBe('FIRST_STOP');
        expect(res.body.data.stops[0].distanceFromPreviousKm).toBe(0);
    });

    it('flags a stop whose safe-until time has already effectively passed by the estimate', async () => {
        const kitchen = await registerKitchenAt(20, 80, 'K Far');
        const ngo = await setupVerifiedNgoAt(18, 73, 'N Far'); // far away, forces meaningful travel time
        const listing = await createListing(kitchen.token, { safeUntilTime: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        await claim(ngo.token, listing.id);

        const res = await preview(ngo.token, [listing.id]);
        expect(res.status).toBe(200);
        expect(res.body.data.stops[0].timeStatus).toBe('EXPIRED_BY_ESTIMATE');
        expect(res.body.data.warnings.length).toBeGreaterThan(0);
    });
});

describe('POST /api/rescue-routes/preview - regression: existing rescue/claim/collection flows still work', () => {
    it('claim -> confirm pickup -> collect still succeeds end to end after adding the route feature', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Regression');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Regression');
        const listing = await createListing(kitchen.token);

        const claimed = await claim(ngo.token, listing.id);
        expect(claimed.status).toBe('Claimed');

        const confirmed = await confirmPickup(kitchen.token, listing.id);
        expect(confirmed.status).toBe(200);

        const collected = await collect(kitchen.token, listing.id, listing.quantity);
        expect(collected.status).toBe(200);
        expect(collected.body.listing.status).toBe('Collected');
    });

    it('the rescue-priority endpoint still works for the same claimed listing', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Priority');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Priority');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        const res = await request(app).get('/api/rescue-priorities').set(A(ngo.token));
        expect(res.status).toBe(200);
    });

    it('the donation ledger for a routed listing is unaffected by previewing a route', async () => {
        const kitchen = await registerKitchenAt(18.5, 73.8, 'K Ledger');
        const ngo = await setupVerifiedNgoAt(18.5, 73.8, 'N Ledger');
        const listing = await createListing(kitchen.token);
        await claim(ngo.token, listing.id);

        await preview(ngo.token, [listing.id]);

        const ledgerRes = await request(app).get(`/api/donations/${listing.id}/ledger`).set(A(kitchen.token));
        expect(ledgerRes.status).toBe(200);
        expect(ledgerRes.body.data.eventCount).toBe(2); // SURPLUS_CREATED + SURPLUS_CLAIMED only
    });
});
