const request = require('supertest');
const {
    app,
    pool,
    resetDb,
    registerKitchen,
    registerNgo,
    createSystemAdmin,
    localDateString,
} = require('./testHelpers');

// End-to-end coverage of the Food Processing flow against a real database and the real auth stack:
// raw input -> processing -> finished output -> rejects/waste -> waste analytics -> financial/environmental impact.

const DAY = '2026-03-02'; // a Monday

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const createProduct = (token, body) => request(app).post('/api/processing/products').set(auth(token)).send(body);
const logBatch = (token, body) => request(app).post('/api/processing/batches').set(auth(token)).send(body);
const listBatches = (token) => request(app).get('/api/processing/batches').set(auth(token));
const listProducts = (token) => request(app).get('/api/processing/products').set(auth(token));
const analytics = (token, query = '') => request(app).get(`/api/analytics/waste-attribution${query}`).set(auth(token));

async function newProduct(token, overrides = {}) {
    const res = await createProduct(token, { name: 'Wheat', unit: 'kg', item_type: 'raw_material', ...overrides });
    expect(res.status).toBe(201);
    return res.body.data;
}

const validBatch = (productId, overrides = {}) => ({
    product_id: productId,
    log_date: DAY,
    batch_number: 'B-001',
    input_quantity: 100,
    output_quantity: 90,
    rejects_quantity: 10,
    ...overrides,
});

const countRows = async (table) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('Processing API - authentication and RBAC', () => {
    const endpoints = [
        ['post', '/api/processing/products', { name: 'Wheat', unit: 'kg' }],
        ['get', '/api/processing/products', {}], // explicit body: keeps every row 3 wide so jest-each never injects `done`
        ['post', '/api/processing/batches', { product_id: 1, log_date: DAY, input_quantity: 10 }],
        ['get', '/api/processing/batches', {}],
    ];

    it.each(endpoints)('%s %s rejects a request with no token', async (method, path, body) => {
        const res = await request(app)[method](path).send(body);
        expect(res.status).toBe(401);
    });

    it.each(endpoints)('%s %s rejects an invalid token', async (method, path, body) => {
        const res = await request(app)[method](path).set('Authorization', 'Bearer not-a-real-jwt').send(body);
        expect(res.status).toBe(401);
    });

    it.each(endpoints)('%s %s rejects a deactivated user', async (method, path, body) => {
        const kitchen = await registerKitchen();
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);
        const res = await request(app)[method](path).set(auth(kitchen.token)).send(body);
        expect(res.status).toBe(401);
    });

    it.each(endpoints)('%s %s rejects NGO roles', async (method, path, body) => {
        const ngo = await registerNgo();
        const res = await request(app)[method](path).set(auth(ngo.token)).send(body);
        expect(res.status).toBe(403);
    });

    it('lets kitchen staff view and log batches but only managers create products (RBAC unchanged)', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        const email = `staff${Date.now()}@example.com`;
        await request(app)
            .post('/api/auth/users')
            .set(auth(kitchen.token))
            .send({ name: 'Staff', email, password: 'password123', role: 'KITCHEN_STAFF' });
        const staff = (await request(app).post('/api/auth/login').send({ email, password: 'password123' })).body.token;

        expect((await createProduct(staff, { name: 'Other', unit: 'kg' })).status).toBe(403);
        expect((await listProducts(staff)).status).toBe(200);
        expect((await logBatch(staff, validBatch(product.id))).status).toBe(201);
        expect((await listBatches(staff)).status).toBe(200);
    });

    it('does not let a system admin (no organization) create an orphaned product', async () => {
        const { token } = await createSystemAdmin();
        const res = await createProduct(token, { name: 'Orphan', unit: 'kg' });
        expect(res.status).toBe(403);
        expect(await countRows('menu_items')).toBe(0);

        expect((await listProducts(token)).body.data).toEqual([]);
        expect((await listBatches(token)).body.data).toEqual([]);
    });

    it('does not let a system admin log a batch', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        const { token } = await createSystemAdmin();
        const res = await logBatch(token, validBatch(product.id));
        expect(res.status).toBe(403);
        expect(await countRows('daily_logs')).toBe(0);
    });
});

describe('Processing API - valid products and batches', () => {
    it('creates raw-material and finished products owned by the caller', async () => {
        const kitchen = await registerKitchen();
        const raw = await newProduct(kitchen.token, { name: 'Wheat', cost_per_unit: 20, preparation_cost_per_unit: 2 });
        const finished = await newProduct(kitchen.token, { name: 'Flour', item_type: 'finished_product' });

        expect(raw).toMatchObject({ kitchen_org_id: kitchen.organization.id, name: 'Wheat', unit: 'kg', item_type: 'raw_material', cost_per_unit: 20, preparation_cost_per_unit: 2, is_active: true });
        expect(finished).toMatchObject({ name: 'Flour', item_type: 'finished_product', cost_per_unit: 0 });
    });

    it('defaults the product type to raw_material and trims names', async () => {
        const kitchen = await registerKitchen();
        const res = await createProduct(kitchen.token, { name: '  Sugar  ', unit: ' kg ' });
        expect(res.body.data).toMatchObject({ name: 'Sugar', unit: 'kg', item_type: 'raw_material' });
    });

    it('stores raw input, finished output and rejects on the batch', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        const res = await logBatch(kitchen.token, validBatch(product.id, { input_quantity: 1000, output_quantity: 950, rejects_quantity: 50, batch_number: 'B-77' }));

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('success');
        expect(res.body.data).toMatchObject({
            menu_item_id: product.id,
            log_date: DAY,
            meal_slot: 'BATCH',
            quantity_prepared: 1000,
            output_quantity: 950,
            quantity_leftover: 50,
            batch_number: 'B-77',
        });
    });

    it('accepts numeric strings and defaults optional fields', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        const res = await logBatch(kitchen.token, { product_id: String(product.id), log_date: DAY, input_quantity: '100', batch_number: '   ' });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ quantity_prepared: 100, quantity_leftover: 0, output_quantity: 0, batch_number: null });
    });

    it('lists only production batches (with product name and type), not regular meal logs', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token, { name: 'Flour', item_type: 'finished_product' });
        await logBatch(kitchen.token, validBatch(product.id));

        const dish = (await request(app).post('/api/menu-items').set(auth(kitchen.token)).send({ name: 'Rice', unit: 'kg' })).body.menuItem;
        const regular = await request(app)
            .post('/api/daily-logs')
            .set(auth(kitchen.token))
            .send({ menuItemId: dish.id, logDate: DAY, mealSlot: 'LUNCH', quantityPrepared: 50, quantityLeftover: 5 });
        expect(regular.status).toBe(201);

        const batches = (await listBatches(kitchen.token)).body.data;
        expect(batches).toHaveLength(1);
        expect(batches[0]).toMatchObject({ product_name: 'Flour', item_type: 'finished_product', meal_slot: 'BATCH', quantity_prepared: 100, output_quantity: 90, quantity_leftover: 10 });

        // ...while the kitchen's regular daily-log flow still sees both.
        const logs = (await request(app).get('/api/daily-logs').set(auth(kitchen.token))).body.logs;
        expect(logs.map((l) => l.meal_slot).sort()).toEqual(['BATCH', 'LUNCH']);
    });

    it('lets a product have batches on different dates, and different products on the same date', async () => {
        const kitchen = await registerKitchen();
        const wheat = await newProduct(kitchen.token, { name: 'Wheat' });
        const rice = await newProduct(kitchen.token, { name: 'Rice' });
        expect((await logBatch(kitchen.token, validBatch(wheat.id, { log_date: '2026-03-02' }))).status).toBe(201);
        expect((await logBatch(kitchen.token, validBatch(wheat.id, { log_date: '2026-03-03' }))).status).toBe(201);
        expect((await logBatch(kitchen.token, validBatch(rice.id, { log_date: '2026-03-02' }))).status).toBe(201);
    });

    it('keeps the existing one-batch-per-product-per-day rule with its clear message', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        expect((await logBatch(kitchen.token, validBatch(product.id))).status).toBe(201);
        const duplicate = await logBatch(kitchen.token, validBatch(product.id));
        expect(duplicate.status).toBe(400);
        expect(duplicate.body.message).toMatch(/already exists on this date/);
        expect(await countRows('daily_logs')).toBe(1);
    });
});

describe('Processing API - quantity and input validation', () => {
    it.each([
        ['negative input', { input_quantity: -5 }, /input_quantity must be a number greater than zero/],
        ['zero input', { input_quantity: 0 }, /input_quantity must be a number greater than zero/],
        ['non-numeric input', { input_quantity: 'abc' }, /input_quantity must be a number greater than zero/],
        ['NaN string input', { input_quantity: 'NaN' }, /input_quantity must be a number greater than zero/],
        ['infinite input', { input_quantity: '1e999' }, /input_quantity must be a number greater than zero/],
        ['boolean input', { input_quantity: true }, /input_quantity must be a number greater than zero/],
        ['array input', { input_quantity: [5] }, /input_quantity must be a number greater than zero/],
        ['negative output', { output_quantity: -1 }, /output_quantity must be a number that is zero or greater/],
        ['non-numeric output', { output_quantity: 'lots' }, /output_quantity must be a number that is zero or greater/],
        ['negative rejects', { rejects_quantity: -0.5 }, /rejects_quantity must be a number that is zero or greater/],
        ['non-numeric rejects', { rejects_quantity: {} }, /rejects_quantity must be a number that is zero or greater/],
        ['rejects more than input', { input_quantity: 100, rejects_quantity: 100.5 }, /rejects_quantity cannot be more than input_quantity/],
        ['missing input', { input_quantity: undefined }, /Missing required fields/],
        ['blank input', { input_quantity: '' }, /Missing required fields/],
        ['missing date', { log_date: undefined }, /Missing required fields/],
        ['missing product', { product_id: undefined }, /Missing required fields/],
        ['fractional product id', { product_id: 1.5 }, /product_id must be a positive whole number/],
        ['negative product id', { product_id: -1 }, /product_id must be a positive whole number/],
        ['zero product id', { product_id: 0 }, /product_id must be a positive whole number/],
        ['text product id', { product_id: 'abc' }, /product_id must be a positive whole number/],
        ['relative date', { log_date: 'tomorrow' }, /log_date must be a real calendar date/],
        ['impossible date', { log_date: '2026-02-30' }, /log_date must be a real calendar date/],
        ['wrong date format', { log_date: '02-03-2026' }, /log_date must be a real calendar date/],
        ['numeric date', { log_date: 20260302 }, /log_date must be a real calendar date/],
        ['non-text batch number', { batch_number: 123 }, /batch_number must be text/],
        ['over-long batch number', { batch_number: 'B'.repeat(101) }, /batch_number must be 100 characters or fewer/],
    ])('rejects a batch with %s (400) and stores nothing', async (_label, overrides, message) => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        const body = validBatch(product.id, overrides);
        Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);

        const res = await logBatch(kitchen.token, body);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(message);
        expect(await countRows('daily_logs')).toBe(0);
    });

    it('accepts a batch where nothing was rejected and where all input was rejected', async () => {
        const kitchen = await registerKitchen();
        const a = await newProduct(kitchen.token, { name: 'A' });
        const b = await newProduct(kitchen.token, { name: 'B' });
        expect((await logBatch(kitchen.token, validBatch(a.id, { output_quantity: 100, rejects_quantity: 0 }))).status).toBe(201);
        expect((await logBatch(kitchen.token, validBatch(b.id, { output_quantity: 0, rejects_quantity: 100 }))).status).toBe(201);
    });

    it.each([
        ['missing name', { name: undefined }, /name is required/],
        ['blank name', { name: '   ' }, /name is required/],
        ['non-text name', { name: 42 }, /name is required/],
        ['over-long name', { name: 'N'.repeat(256) }, /name must be 255 characters or fewer/],
        ['missing unit', { unit: undefined }, /unit is required/],
        ['over-long unit', { unit: 'u'.repeat(51) }, /unit must be 50 characters or fewer/],
        ['unknown type', { item_type: 'gadget' }, /item_type must be one of/],
        ['negative cost', { cost_per_unit: -1 }, /cost_per_unit must be a number that is zero or greater/],
        ['non-numeric cost', { cost_per_unit: 'cheap' }, /cost_per_unit must be a number that is zero or greater/],
        ['negative preparation cost', { preparation_cost_per_unit: -3 }, /preparation_cost_per_unit must be a number that is zero or greater/],
    ])('rejects a product with %s (400) and stores nothing', async (_label, overrides, message) => {
        const kitchen = await registerKitchen();
        const body = { name: 'Wheat', unit: 'kg', item_type: 'raw_material', ...overrides };
        Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);

        const res = await createProduct(kitchen.token, body);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(message);
        expect(await countRows('menu_items')).toBe(0);
    });
});

describe('Processing API - ownership and organization isolation', () => {
    it("rejects a batch against another organization's product and stores nothing", async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const productA = await newProduct(kitchenA.token);

        const res = await logBatch(kitchenB.token, validBatch(productA.id));
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Product not found');
        expect(await countRows('daily_logs')).toBe(0);
    });

    it('rejects a batch against a product that does not exist', async () => {
        const kitchen = await registerKitchen();
        expect((await logBatch(kitchen.token, validBatch(999999))).status).toBe(404);
    });

    it('rejects a batch against a deactivated product (same rule as regular daily logs)', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        const removed = await request(app).delete(`/api/menu-items/${product.id}`).set(auth(kitchen.token));
        expect(removed.status).toBe(200);

        const res = await logBatch(kitchen.token, validBatch(product.id));
        expect(res.status).toBe(404);
        expect(await countRows('daily_logs')).toBe(0);
    });

    it('never shows one organization the other\'s products, batches, analytics or financial impact', async () => {
        const kitchenA = await registerKitchen();
        const kitchenB = await registerKitchen();
        const productA = await newProduct(kitchenA.token, { name: 'SecretFlourA', cost_per_unit: 5 });
        await logBatch(kitchenA.token, validBatch(productA.id, { log_date: localDateString(), input_quantity: 100, rejects_quantity: 20, output_quantity: 80 }));
        const productB = await newProduct(kitchenB.token, { name: 'PlainSugarB' });
        await logBatch(kitchenB.token, validBatch(productB.id, { log_date: localDateString(), input_quantity: 10, rejects_quantity: 1, output_quantity: 9 }));

        const products = (await listProducts(kitchenB.token)).body.data;
        expect(products.map((p) => p.name)).toEqual(['PlainSugarB']);
        const batches = (await listBatches(kitchenB.token)).body.data;
        expect(batches).toHaveLength(1);
        expect(batches[0].product_name).toBe('PlainSugarB');

        const analyticsB = (await analytics(kitchenB.token)).body.data;
        expect(analyticsB.totals).toMatchObject({ logCount: 1, preparedQuantity: 10, wasteQuantity: 1 });
        expect(JSON.stringify(analyticsB)).not.toContain('SecretFlourA');

        const financialB = (await request(app).get('/api/financial-impact?period=daily').set(auth(kitchenB.token))).body.data;
        expect(financialB.totalEstimatedLoss).toBe(0); // B's product has no cost configured; A's rejects never leak in
        expect(financialB.environmentalImpact.estimatedCo2eKg).toBe(2.5); // only B's 1 unit of rejects

        const analyticsA = (await analytics(kitchenA.token)).body.data;
        expect(analyticsA.totals).toMatchObject({ logCount: 1, preparedQuantity: 100, wasteQuantity: 20 });
    });
});

describe('Processing flow - waste calculation and analytics inclusion', () => {
    it('counts rejects as waste and input as prepared, consistently with the daily-log units', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token, { name: 'Flour', item_type: 'finished_product' });
        await logBatch(kitchen.token, validBatch(product.id, { input_quantity: 200, output_quantity: 180, rejects_quantity: 20 }));

        const { rows } = await pool.query('SELECT quantity_prepared, quantity_leftover, output_quantity FROM daily_logs');
        expect(rows).toEqual([{ quantity_prepared: 200, quantity_leftover: 20, output_quantity: 180 }]);

        const data = (await analytics(kitchen.token)).body.data;
        expect(data.totals).toEqual({ logCount: 1, preparedQuantity: 200, consumedQuantity: 180, wasteQuantity: 20, wastePercentage: 10 });
        expect(data.byMenuItem[0]).toMatchObject({ name: 'Flour', unit: 'kg', preparedQuantity: 200, wasteQuantity: 20, wastePercentage: 10, contributionPercentage: 100 });
        expect(data.byMealSlot).toHaveLength(1);
        expect(data.byMealSlot[0]).toMatchObject({ mealSlot: 'BATCH', wasteQuantity: 20, contributionPercentage: 100 });
        expect(data.byWeekday[0]).toMatchObject({ weekdayName: 'Monday', wasteQuantity: 20 });
    });

    it("includes processing batches alongside the kitchen's regular logs in waste analytics", async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token, { name: 'Flour' });
        await logBatch(kitchen.token, validBatch(product.id, { input_quantity: 200, output_quantity: 180, rejects_quantity: 20 }));
        const dish = (await request(app).post('/api/menu-items').set(auth(kitchen.token)).send({ name: 'Rice', unit: 'kg' })).body.menuItem;
        await request(app)
            .post('/api/daily-logs')
            .set(auth(kitchen.token))
            .send({ menuItemId: dish.id, logDate: DAY, mealSlot: 'LUNCH', quantityPrepared: 100, quantityLeftover: 10 });

        const data = (await analytics(kitchen.token)).body.data;
        expect(data.totals).toMatchObject({ logCount: 2, preparedQuantity: 300, wasteQuantity: 30, wastePercentage: 10 });
        expect(data.byMealSlot.map((s) => s.mealSlot).sort()).toEqual(['BATCH', 'LUNCH']);
        expect(data.byMenuItem.map((i) => [i.name, i.contributionPercentage])).toEqual([['Flour', 66.7], ['Rice', 33.3]]);
    });

    it('respects the analytics date range for batches', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        await logBatch(kitchen.token, validBatch(product.id, { log_date: '2026-03-02', rejects_quantity: 10 }));
        await logBatch(kitchen.token, validBatch(product.id, { log_date: '2026-03-10', rejects_quantity: 30, output_quantity: 70 }));

        const data = (await analytics(kitchen.token, '?startDate=2026-03-05')).body.data;
        expect(data.totals).toMatchObject({ logCount: 1, wasteQuantity: 30 });
    });

    it('carries rejects into financial and environmental impact using the product cost', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token, { name: 'Wheat', cost_per_unit: 2, preparation_cost_per_unit: 1 });
        await logBatch(kitchen.token, validBatch(product.id, { log_date: localDateString(), input_quantity: 100, output_quantity: 95, rejects_quantity: 5 }));

        const res = await request(app).get('/api/financial-impact?period=daily').set(auth(kitchen.token));
        expect(res.status).toBe(200);
        const { data } = res.body;
        expect(data.totalEstimatedLoss).toBe(15); // 5 rejects x (2 + 1)
        expect(data.breakdown.lossByItem).toEqual({ Wheat: 15 });
        expect(data.environmentalImpact).toEqual({ estimatedCo2eKg: 12.5, mealEquivalents: 12, isEstimate: true });
        expect(data.isEstimate).toBe(true);
    });

    it('reports no waste when nothing was rejected', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token);
        await logBatch(kitchen.token, validBatch(product.id, { input_quantity: 100, output_quantity: 100, rejects_quantity: 0 }));

        const data = (await analytics(kitchen.token)).body.data;
        expect(data.totals).toMatchObject({ wasteQuantity: 0, wastePercentage: 0 });
        expect(data.insights[0].type).toBe('no_waste');
    });

    it('feeds batches into the same history the forecast engine reads', async () => {
        const kitchen = await registerKitchen();
        const product = await newProduct(kitchen.token, { name: 'Wheat' });
        for (const day of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) {
            await logBatch(kitchen.token, validBatch(product.id, { log_date: day, input_quantity: 100, output_quantity: 90, rejects_quantity: 10 }));
        }
        const res = await request(app).get(`/api/forecasts/${product.id}?targetDate=2026-03-09`).set(auth(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data.modelVersion).toBe('stat_context_v2');
        expect(res.body.data.keyFactors.data_points_used).toBe(4);
        expect(res.body.data.keyFactors.central_estimate).toBeCloseTo(90, 0); // accepted input = input - rejects
    });
});

describe('Migration 010 behavior stays intact', () => {
    async function insertRaw(mealSlot, extra = {}) {
        const kitchen = await registerKitchen();
        const { rows } = await pool.query(
            "INSERT INTO menu_items (kitchen_org_id, name, unit) VALUES ($1, 'X', 'kg') RETURNING id",
            [kitchen.organization.id]
        );
        return pool.query(
            'INSERT INTO daily_logs (menu_item_id, log_date, meal_slot, quantity_prepared) VALUES ($1, $2, $3, $4)',
            [rows[0].id, extra.date || DAY, mealSlot, extra.prepared ?? 10]
        );
    }

    it('allows BATCH and the four kitchen meal slots at the database level', async () => {
        const { rows } = await pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'daily_logs_meal_slot_check'");
        ['BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER', 'BATCH'].forEach((slot) => expect(rows[0].def).toContain(`'${slot}'`));
        await expect(insertRaw('BATCH')).resolves.toBeDefined();
    });

    it('still rejects other meal slots, including the old mixed-case literal', async () => {
        await expect(insertRaw('Batch')).rejects.toMatchObject({ code: '23514' });
        await expect(insertRaw('BRUNCH')).rejects.toMatchObject({ code: '23514' });
    });

    it('still enforces non-negative quantities on the log columns it covers', async () => {
        await expect(insertRaw('BATCH', { prepared: -1 })).rejects.toMatchObject({ code: '23514' });
    });

    it('does not open the kitchen daily-log API to the BATCH slot', async () => {
        const kitchen = await registerKitchen();
        const dish = (await request(app).post('/api/menu-items').set(auth(kitchen.token)).send({ name: 'Rice', unit: 'kg' })).body.menuItem;
        const base = { menuItemId: dish.id, logDate: DAY, quantityPrepared: 10, quantityLeftover: 1 };
        expect((await request(app).post('/api/daily-logs').set(auth(kitchen.token)).send({ ...base, mealSlot: 'BATCH' })).status).toBe(400);
        expect((await request(app).post('/api/daily-logs').set(auth(kitchen.token)).send({ ...base, mealSlot: 'LUNCH' })).status).toBe(201);
    });
});
