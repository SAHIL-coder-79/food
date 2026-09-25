const request = require('supertest');
const {
    app,
    pool,
    resetDb,
    registerKitchen,
    registerNgo,
    createSystemAdmin,
    verifyNgo,
} = require('./testHelpers');

const LISTINGS = '/api/surplus-listings';
const MIN = 60000;
const minutesAgo = (m) => new Date(Date.now() - m * MIN).toISOString();
const minutesFromNow = (m) => new Date(Date.now() + m * MIN).toISOString();

const post = (token, path, body) => request(app).post(`${LISTINGS}${path}`).set('Authorization', `Bearer ${token}`).send(body);
const get = (token, path) => request(app).get(`${LISTINGS}${path}`).set('Authorization', `Bearer ${token}`);

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, EXPIRED: 3 };

describe('Spoilage-risk estimate: POST /api/surplus-listings/spoilage-estimate', () => {
    beforeEach(async () => {
        await resetDb();
    });

    describe('authentication and RBAC', () => {
        it('rejects a request with no token', async () => {
            const res = await request(app).post(`${LISTINGS}/spoilage-estimate`).send({ foodType: 'Rice', preparedTime: minutesAgo(10) });
            expect(res.status).toBe(401);
        });

        it('rejects an invalid token', async () => {
            const res = await request(app)
                .post(`${LISTINGS}/spoilage-estimate`)
                .set('Authorization', 'Bearer not-a-real-jwt')
                .send({ foodType: 'Rice', preparedTime: minutesAgo(10) });
            expect(res.status).toBe(401);
        });

        it('rejects a deactivated user', async () => {
            const kitchen = await registerKitchen();
            await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);
            const res = await post(kitchen.token, '/spoilage-estimate', { foodType: 'Rice', preparedTime: minutesAgo(10) });
            expect(res.status).toBe(401);
        });

        it('rejects NGO roles', async () => {
            const ngo = await registerNgo();
            const res = await post(ngo.token, '/spoilage-estimate', { foodType: 'Rice', preparedTime: minutesAgo(10) });
            expect(res.status).toBe(403);
        });
    });

    describe('estimate', () => {
        it('returns a fully shaped, clearly-labelled estimate for fresh food', async () => {
            const kitchen = await registerKitchen();
            const res = await post(kitchen.token, '/spoilage-estimate', {
                foodType: 'Rice',
                quantity: 10,
                preparedTime: minutesAgo(10),
                ambientTemperatureC: 25,
            });

            expect(res.status).toBe(200);
            const a = res.body.spoilageAssessment;
            expect(a.riskLevel).toBe('LOW');
            expect(a.isEstimate).toBe(true);
            expect(new Date(a.estimatedSafeUntil).getTime()).toBeGreaterThan(Date.now());
            expect(a.confidence).toBeGreaterThan(0);
            expect(a.confidence).toBeLessThan(1);
            expect(a.reasons.length).toBeGreaterThan(0);
            expect(a.factorsUsed.map((f) => f.factor)).toEqual(expect.arrayContaining(['food_category', 'preparation_time', 'ambient_temperature', 'quantity']));
            expect(a.disclaimer).toMatch(/not a food-safety certification/i);
        });

        it.each([
            [10, 'LOW'],
            [150, 'HIGH'],
            [400, 'EXPIRED'],
        ])('rice prepared %i minutes ago at 25 C is %s', async (age, expected) => {
            const kitchen = await registerKitchen();
            const res = await post(kitchen.token, '/spoilage-estimate', { foodType: 'Rice', preparedTime: minutesAgo(age), ambientTemperatureC: 25 });
            expect(res.body.spoilageAssessment.riskLevel).toBe(expected);
        });

        it('gives different windows for different food categories', async () => {
            const kitchen = await registerKitchen();
            const prep = minutesAgo(30);
            const windows = {};
            for (const foodType of ['Chicken curry', 'Rice', 'Roti', 'Packaged biscuits']) {
                const res = await post(kitchen.token, '/spoilage-estimate', { foodType, preparedTime: prep, ambientTemperatureC: 25 });
                windows[foodType] = res.body.spoilageAssessment.safeWindowHours;
            }
            expect(windows).toEqual({ 'Chicken curry': 2, Rice: 3, Roti: 6, 'Packaged biscuits': 24 });
        });

        it('works with missing optional data and says what was missing', async () => {
            const kitchen = await registerKitchen();
            const res = await post(kitchen.token, '/spoilage-estimate', { foodType: 'Rice', preparedTime: minutesAgo(10) });
            expect(res.status).toBe(200);
            expect(res.body.spoilageAssessment.factorsNotProvided).toEqual(expect.arrayContaining(['ambient_temperature', 'quantity']));
            expect(res.body.spoilageAssessment.reasons.join(' ')).toMatch(/warm temperature was assumed/);
        });

        it('can assess only a declared safe-until time', async () => {
            const kitchen = await registerKitchen();
            const res = await post(kitchen.token, '/spoilage-estimate', { foodType: 'Rice', safeUntilTime: minutesFromNow(20) });
            expect(res.status).toBe(200);
            expect(res.body.spoilageAssessment.riskLevel).toBe('HIGH');
            expect(res.body.spoilageAssessment.estimatedSafeUntilSource).toBe('declared_safe_until');
        });

        it('is deterministic for identical requests', async () => {
            const kitchen = await registerKitchen();
            const body = { foodType: 'Chicken Biryani', quantity: 80, ambientTemperatureC: 32, preparedTime: minutesAgo(20) };
            const first = (await post(kitchen.token, '/spoilage-estimate', body)).body.spoilageAssessment;
            const second = (await post(kitchen.token, '/spoilage-estimate', body)).body.spoilageAssessment;
            expect(second.riskLevel).toBe(first.riskLevel);
            expect(second.estimatedSafeUntil).toBe(first.estimatedSafeUntil);
            expect(second.confidence).toBe(first.confidence);
            expect(second.reasons.slice(0, 3)).toEqual(first.reasons.slice(0, 3));
            expect(second.factorsUsed.map((f) => f.factor)).toEqual(first.factorsUsed.map((f) => f.factor));
        });

        it('does not create or change anything', async () => {
            const kitchen = await registerKitchen();
            await post(kitchen.token, '/spoilage-estimate', { foodType: 'Rice', preparedTime: minutesAgo(10) });
            const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM surplus_listings');
            expect(rows[0].n).toBe(0);
        });

        it.each([
            [{ foodType: 'Rice' }, 'no time basis'],
            [{ preparedTime: minutesAgo(10) }, 'no food type'],
            [{ foodType: 'Rice', preparedTime: 'yesterday' }, 'bad preparedTime'],
            [{ foodType: 'Rice', preparedTime: minutesAgo(10), ambientTemperatureC: 200 }, 'temperature out of range'],
            [{ foodType: 'Rice', preparedTime: minutesAgo(10), ambientTemperatureC: 'hot' }, 'temperature not a number'],
            [{ foodType: 'Rice', preparedTime: minutesAgo(10), quantity: -5 }, 'negative quantity'],
        ])('rejects invalid input (%#: %s) with 400', async (body) => {
            const kitchen = await registerKitchen();
            const res = await post(kitchen.token, '/spoilage-estimate', body);
            expect(res.status).toBe(400);
        });
    });
});

describe('Spoilage risk integrated into surplus creation (staff override)', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('keeps the existing behavior when staff supply safeUntilTime, and adds an advisory assessment', async () => {
        const kitchen = await registerKitchen();
        const safeUntil = minutesFromNow(60);
        const res = await post(kitchen.token, '', { quantity: 10, foodType: 'Rice', safeUntilTime: safeUntil });

        expect(res.status).toBe(201);
        expect(new Date(res.body.listing.safe_until_time).toISOString()).toBe(new Date(safeUntil).toISOString());
        expect(res.body.spoilageAssessment.isEstimate).toBe(true);
        expect(res.body.spoilageAssessment.safeUntilSource).toBe('staff_override');
        expect(res.body.spoilageAssessment.appliedSafeUntil).toBe(new Date(safeUntil).toISOString());
    });

    it('uses the estimated safe-until time when staff give a preparation time but no safeUntilTime', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', {
            quantity: 10, foodType: 'Rice', preparedTime: minutesAgo(10), ambientTemperatureC: 25,
        });

        expect(res.status).toBe(201);
        const a = res.body.spoilageAssessment;
        expect(a.safeUntilSource).toBe('estimated');
        expect(new Date(res.body.listing.safe_until_time).toISOString()).toBe(a.estimatedSafeUntil);
        expect(res.body.listing.prepared_time).toBeTruthy();
        expect(a.riskLevel).toBe('LOW');
    });

    it('lets staff override a shorter estimate with a later safe-until time (their decision is kept)', async () => {
        const kitchen = await registerKitchen();
        const staffTime = minutesFromNow(300);
        const res = await post(kitchen.token, '', {
            quantity: 10, foodType: 'Chicken curry', preparedTime: minutesAgo(10), ambientTemperatureC: 25, safeUntilTime: staffTime,
        });

        expect(res.status).toBe(201);
        expect(new Date(res.body.listing.safe_until_time).toISOString()).toBe(new Date(staffTime).toISOString());
        const a = res.body.spoilageAssessment;
        expect(a.safeUntilSource).toBe('staff_override');
        expect(new Date(a.estimatedSafeUntil).getTime()).toBeLessThan(new Date(staffTime).getTime());
        expect(a.reasons.join(' ')).toMatch(/later than this estimate/);
        expect(a.riskLevel).toBe('LOW'); // the override does not change the estimate
    });

    it('never blocks a donation because of the estimate: an EXPIRED estimate with an explicit staff time still creates the listing', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', {
            quantity: 10, foodType: 'Rice', preparedTime: minutesAgo(400), ambientTemperatureC: 25, safeUntilTime: minutesFromNow(60),
        });

        expect(res.status).toBe(201);
        expect(res.body.spoilageAssessment.riskLevel).toBe('EXPIRED');
        expect(res.body.listing.status).toBe('Available');
    });

    it('does not block HIGH-risk food either', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', {
            quantity: 10, foodType: 'Rice', preparedTime: minutesAgo(150), ambientTemperatureC: 25, safeUntilTime: minutesFromNow(25),
        });
        expect(res.status).toBe(201);
        expect(res.body.spoilageAssessment.riskLevel).toBe('HIGH');
    });

    it('when the estimate has already passed and no override is given, explains how to override instead of guessing', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', { quantity: 10, foodType: 'Rice', preparedTime: minutesAgo(400), ambientTemperatureC: 25 });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/provide safeUntilTime/i);
        expect(res.body.details.spoilageAssessment.riskLevel).toBe('EXPIRED');
        const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM surplus_listings');
        expect(rows[0].n).toBe(0);
    });

    it('still rejects an explicit staff safe-until time in the past (existing rule)', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', { quantity: 10, foodType: 'Rice', safeUntilTime: minutesAgo(30) });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Safe-until time must be in the future');
    });

    it('requires either safeUntilTime or preparedTime', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', { quantity: 10, foodType: 'Rice' });
        expect(res.status).toBe(400);
    });

    it('validates the optional ambient temperature', async () => {
        const kitchen = await registerKitchen();
        const res = await post(kitchen.token, '', { quantity: 10, foodType: 'Rice', safeUntilTime: minutesFromNow(60), ambientTemperatureC: 999 });
        expect(res.status).toBe(400);
    });

    it('still rejects NGO roles from creating listings', async () => {
        const ngo = await registerNgo();
        const res = await post(ngo.token, '', { quantity: 10, foodType: 'Rice', preparedTime: minutesAgo(10) });
        expect(res.status).toBe(403);
    });

    it('applies preparation-time effects: earlier preparation gives an earlier estimated safe-until', async () => {
        const kitchen = await registerKitchen();
        const older = await post(kitchen.token, '', { quantity: 5, foodType: 'Rice', preparedTime: minutesAgo(60), ambientTemperatureC: 25 });
        const newer = await post(kitchen.token, '', { quantity: 5, foodType: 'Rice', preparedTime: minutesAgo(20), ambientTemperatureC: 25 });
        const diff = new Date(newer.body.spoilageAssessment.estimatedSafeUntil) - new Date(older.body.spoilageAssessment.estimatedSafeUntil);
        expect(Math.round(diff / MIN)).toBe(40);
        expect(RANK[newer.body.spoilageAssessment.riskLevel]).toBeLessThanOrEqual(RANK[older.body.spoilageAssessment.riskLevel]);
    });
});

describe('GET /api/surplus-listings/:id/spoilage-assessment (organization isolation)', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    async function createListing(token, overrides = {}) {
        const res = await post(token, '', {
            quantity: 10, foodType: 'Rice', preparedTime: minutesAgo(30), ambientTemperatureC: 25, safeUntilTime: minutesFromNow(120), ...overrides,
        });
        expect(res.status).toBe(201);
        return res.body.listing;
    }

    it('rejects a request with no token', async () => {
        const res = await request(app).get(`${LISTINGS}/1/spoilage-assessment`);
        expect(res.status).toBe(401);
    });

    it('lets the owning kitchen view the assessment of its own listing', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const res = await get(kitchen.token, `/${listing.id}/spoilage-assessment?ambientTemperatureC=25`);

        expect(res.status).toBe(200);
        const a = res.body.spoilageAssessment;
        expect(a.listingId).toBe(listing.id);
        expect(a.isEstimate).toBe(true);
        expect(a.riskLevel).toBe('LOW');
        expect(a.appliedSafeUntil).toBe(new Date(listing.safe_until_time).toISOString());
        expect(a.factorsUsed.map((f) => f.factor)).toEqual(expect.arrayContaining(['preparation_time', 'declared_safe_until']));
    });

    it("blocks another kitchen from viewing a listing's assessment", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const listing = await createListing(kitchenA.token);
        const res = await get(kitchenB.token, `/${listing.id}/spoilage-assessment`);
        expect(res.status).toBe(403);
    });

    it('blocks an NGO that has not claimed the listing', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const ngo = await registerNgo();
        const res = await get(ngo.token, `/${listing.id}/spoilage-assessment`);
        expect(res.status).toBe(403);
    });

    it('lets the NGO that claimed the listing view it', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const ngo = await registerNgo();
        const { token: adminToken } = await createSystemAdmin();
        await verifyNgo(ngo.organization.id, adminToken);
        const claim = await request(app)
            .post(`${LISTINGS}/${listing.id}/claim`)
            .set('Authorization', `Bearer ${ngo.token}`)
            .send({ proposedPickupTime: minutesFromNow(30) });
        expect(claim.status).toBe(200);

        const res = await get(ngo.token, `/${listing.id}/spoilage-assessment`);
        expect(res.status).toBe(200);
        expect(res.body.spoilageAssessment.listingId).toBe(listing.id);
    });

    it('blocks a system admin (not a kitchen or claiming NGO)', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const { token } = await createSystemAdmin();
        const res = await get(token, `/${listing.id}/spoilage-assessment`);
        expect(res.status).toBe(403);
    });

    it('returns 404 for an unknown listing and 400 for a malformed id or temperature', async () => {
        const kitchen = await registerKitchen();
        expect((await get(kitchen.token, '/999999/spoilage-assessment')).status).toBe(404);
        expect((await get(kitchen.token, '/abc/spoilage-assessment')).status).toBe(400);
        const listing = await createListing(kitchen.token);
        expect((await get(kitchen.token, `/${listing.id}/spoilage-assessment?ambientTemperatureC=999`)).status).toBe(400);
    });

    it('reflects the ambient temperature supplied for the request', async () => {
        const kitchen = await registerKitchen();
        const listing = await createListing(kitchen.token);
        const room = (await get(kitchen.token, `/${listing.id}/spoilage-assessment?ambientTemperatureC=25`)).body.spoilageAssessment;
        const hot = (await get(kitchen.token, `/${listing.id}/spoilage-assessment?ambientTemperatureC=40`)).body.spoilageAssessment;
        expect(hot.safeWindowHours).toBeLessThan(room.safeWindowHours);
        expect(new Date(hot.estimatedSafeUntil).getTime()).toBeLessThan(new Date(room.estimatedSafeUntil).getTime());
    });

    it('does not leak other listings or organizations in the response', async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const listingA = await createListing(kitchenA.token, { foodType: 'SecretBiryaniA' });
        await createListing(kitchenB.token, { foodType: 'PlainRiceB' });
        const res = await get(kitchenA.token, `/${listingA.id}/spoilage-assessment`);
        expect(JSON.stringify(res.body)).not.toContain('PlainRiceB');
        expect(JSON.stringify(res.body)).not.toMatch(/kitchen_org_id|password|organization/i);
    });
});
