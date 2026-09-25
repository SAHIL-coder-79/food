const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, localDateString } = require('./testHelpers');

async function createMenuItem(token, overrides = {}) {
    const res = await request(app)
        .post('/api/menu-items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rice', unit: 'kg', costPerUnit: 2, preparationCostPerUnit: 1, ...overrides });
    return res.body.menuItem;
}

async function createDailyLog(token, menuItemId, overrides = {}) {
    const res = await request(app)
        .post('/api/daily-logs')
        .set('Authorization', `Bearer ${token}`)
        .send({
            menuItemId,
            logDate: localDateString(),
            mealSlot: 'LUNCH',
            quantityPrepared: 20,
            quantityLeftover: 10,
            ...overrides,
        });
    return res.body.log;
}

describe('GET /api/financial-impact', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects a request with no auth token', async () => {
        const res = await request(app).get('/api/financial-impact?period=daily');
        expect(res.status).toBe(401);
    });

    it('returns loss metrics for a KITCHEN_MANAGER using the cost fields set on menu items', async () => {
        const kitchen = await registerKitchen();
        const menuItem = await createMenuItem(kitchen.token);
        await createDailyLog(kitchen.token, menuItem.id);

        const res = await request(app)
            .get('/api/financial-impact?period=daily')
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.statusCode).toBe(200);
        // 10 leftover * (cost_per_unit 2 + preparation_cost_per_unit 1) = 30
        expect(res.body.data.totalEstimatedLoss).toBe(30);
        // Environmental estimate: 10 leftover units * 2.5 kg CO2e/unit = 25
        expect(res.body.data.environmentalImpact.estimatedCo2eKg).toBe(25);
        expect(res.body.data.environmentalImpact.mealEquivalents).toBe(25);
        expect(res.body.data.environmentalImpact.isEstimate).toBe(true);
    });

    // Integration gap found by the end-to-end run: surplus collected by NGOs was recorded but never reached the impact report.
    describe('rescued surplus (collected by NGOs)', () => {
        const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
        const bearer = (token) => ({ Authorization: `Bearer ${token}` });
        const impact = async (token, period = 'monthly') => (await request(app).get(`/api/financial-impact?period=${period}`).set(bearer(token))).body.data;

        async function postListing(kitchenToken, quantity) {
            return (await request(app).post('/api/surplus-listings').set(bearer(kitchenToken)).send({ quantity, foodType: 'Rice', safeUntilTime: inHours(5) })).body.listing;
        }
        async function claim(listing, ngo) {
            await request(app).post(`/api/surplus-listings/${listing.id}/claim`).set(bearer(ngo.token)).send({ proposedPickupTime: inHours(1) });
        }
        async function collectedListing(kitchenToken, ngo, quantity, collected) {
            const listing = await postListing(kitchenToken, quantity);
            await claim(listing, ngo);
            const res = await request(app).patch(`/api/surplus-listings/${listing.id}/collect`).set(bearer(ngo.token)).send({ quantityCollected: collected });
            expect(res.status).toBe(200);
            return listing;
        }
        async function verifiedNgo() {
            const ngo = await registerNgo();
            await pool.query("UPDATE organizations SET verification_status = 'verified' WHERE id = $1", [ngo.organization.id]);
            return ngo;
        }

        it('reports zero rescued food when nothing was collected', async () => {
            const kitchen = await registerKitchen();
            expect((await impact(kitchen.token)).rescued).toMatchObject({ listingsCollected: 0, collectedQuantity: 0, mealEquivalents: 0, co2eAvoidedKg: 0, isEstimate: true });
        });

        it('counts collected surplus with the same meal and CO2e factors, without changing the loss figures', async () => {
            const kitchen = await registerKitchen();
            const ngo = await verifiedNgo();
            const item = await createMenuItem(kitchen.token);
            await createDailyLog(kitchen.token, item.id, { quantityLeftover: 10 });
            const before = await impact(kitchen.token);

            await collectedListing(kitchen.token, ngo, 10, 6);
            await collectedListing(kitchen.token, ngo, 4, 4);
            const after = await impact(kitchen.token);

            expect(after.rescued).toMatchObject({ listingsCollected: 2, collectedQuantity: 10, mealEquivalents: 25, co2eAvoidedKg: 25 });
            expect(after.totalEstimatedLoss).toBe(before.totalEstimatedLoss);
            expect(after.environmentalImpact).toEqual(before.environmentalImpact);
            expect(after.breakdown).toEqual(before.breakdown);
        });

        it('ignores listings that are only claimed, and other kitchens collections', async () => {
            const kitchen = await registerKitchen();
            const other = await registerKitchen({ organizationName: 'Other Kitchen' });
            const ngo = await verifiedNgo();
            await collectedListing(other.token, ngo, 20, 20); // another organization's rescue
            await claim(await postListing(kitchen.token, 5), ngo); // claimed but never collected

            expect((await impact(kitchen.token)).rescued).toMatchObject({ listingsCollected: 0, collectedQuantity: 0 });
            expect((await impact(other.token)).rescued).toMatchObject({ listingsCollected: 1, collectedQuantity: 20, mealEquivalents: 50 });
        });

        it('only counts collections inside the requested period', async () => {
            const kitchen = await registerKitchen();
            const ngo = await verifiedNgo();
            const listing = await collectedListing(kitchen.token, ngo, 10, 10);
            expect((await impact(kitchen.token, 'daily')).rescued.collectedQuantity).toBe(10);
            await pool.query("UPDATE transactions_log SET collected_at = CURRENT_TIMESTAMP - INTERVAL '3 days' WHERE surplus_listing_id = $1", [listing.id]);
            expect((await impact(kitchen.token, 'daily')).rescued.collectedQuantity).toBe(0);
            expect((await impact(kitchen.token, 'weekly')).rescued.collectedQuantity).toBe(10);
        });
    });

    it('rejects requests with an invalid period', async () => {
        const kitchen = await registerKitchen();

        const res = await request(app)
            .get('/api/financial-impact?period=yearly')
            .set('Authorization', `Bearer ${kitchen.token}`);

        expect(res.statusCode).toBe(400);
    });

    it('rejects unauthorized roles', async () => {
        const ngo = await registerNgo();

        const res = await request(app)
            .get('/api/financial-impact')
            .set('Authorization', `Bearer ${ngo.token}`);

        expect(res.statusCode).toBe(403);
    });
});
