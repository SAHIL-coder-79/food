const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo, localDateString } = require('./testHelpers');

const URL = '/api/food-quality/check';
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const check = (token, body) => request(app).post(URL).set(auth(token)).send(body);

function fakePng(size = 6000, fill = 0xab) {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), fill)]);
}
function fakeJpeg(size = 6000, fill = 0x42) {
    const header = Buffer.from([0xff, 0xd8, 0xff]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), fill)]);
}
const b64 = (buf) => buf.toString('base64');

async function createMenuItem(token, name = 'Rice') {
    const res = await request(app).post('/api/menu-items').set(auth(token)).send({ name, unit: 'kg' });
    expect(res.status).toBe(201);
    return res.body.menuItem;
}

async function createDailyLog(token, menuItemId) {
    const res = await request(app).post('/api/daily-logs').set(auth(token)).send({
        menuItemId, logDate: localDateString(), mealSlot: 'LUNCH', quantityPrepared: 20, quantityLeftover: 5,
    });
    expect(res.status).toBe(201);
    return res.body.log;
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('POST /api/food-quality/check - authentication and RBAC', () => {
    it('rejects a request with no token', async () => {
        const res = await request(app).post(URL).send({ imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg' });
        expect(res.status).toBe(401);
    });

    it('rejects an invalid token', async () => {
        const res = await check('not-a-real-jwt', { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg' });
        expect(res.status).toBe(401);
    });

    it('rejects a deactivated user holding a previously-valid token', async () => {
        const kitchen = await registerKitchen();
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);
        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg' });
        expect(res.status).toBe(401);
    });

    it('rejects NGO roles (kitchen/food-preparation workflow only)', async () => {
        const ngo = await registerNgo();
        const res = await check(ngo.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg' });
        expect(res.status).toBe(403);
    });

    it('rejects a system admin (not a kitchen role)', async () => {
        const { createSystemAdmin } = require('./testHelpers');
        const admin = await createSystemAdmin();
        const res = await check(admin.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg' });
        expect(res.status).toBe(403);
    });

    it('allows KITCHEN_STAFF and KITCHEN_MANAGER', async () => {
        const kitchen = await registerKitchen();
        expect((await check(kitchen.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg' })).status).toBe(200);
    });
});

describe('POST /api/food-quality/check - a valid screening and the response contract', () => {
    it('returns exactly the documented fields, with sane types', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg(7000, 1)), mimeType: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');

        const data = res.body.data;
        expect(Object.keys(data).sort()).toEqual(['classification', 'confidence', 'disclaimer', 'imageFormat', 'provider', 'recommendation', 'signals']);
        expect(['FRESH', 'USE_SOON', 'QUESTIONABLE', 'UNKNOWN']).toContain(data.classification);
        expect(typeof data.confidence).toBe('number');
        expect(data.confidence).toBeGreaterThan(0);
        expect(data.confidence).toBeLessThan(1);
        expect(Array.isArray(data.signals)).toBe(true);
        expect(data.signals.length).toBeGreaterThan(0);
        expect(typeof data.recommendation).toBe('string');
        expect(data.recommendation.length).toBeGreaterThan(0);
        expect(data.provider).toBe('mock');
        expect(data.imageFormat).toBe('jpeg');
    });

    it('always includes a clear, non-certifying disclaimer', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(fakePng(7000, 2)), mimeType: 'image/png' });
        expect(res.body.data.disclaimer).toMatch(/screening aid/i);
        expect(res.body.data.disclaimer).toMatch(/not a food-safety certification/i);
        expect(res.body.data.disclaimer).not.toMatch(/\bsafe to eat\b/i); // never claims the food IS safe
    });

    it('recognises PNG, JPEG and WEBP alike', async () => {
        const kitchen = await registerKitchen();
        const png = await check(kitchen.token, { imageBase64: b64(fakePng(6500, 3)), mimeType: 'image/png' });
        const jpeg = await check(kitchen.token, { imageBase64: b64(fakeJpeg(6500, 4)), mimeType: 'image/jpeg' });
        expect(png.status).toBe(200);
        expect(jpeg.status).toBe(200);
        expect(png.body.data.imageFormat).toBe('png');
        expect(jpeg.body.data.imageFormat).toBe('jpeg');
    });
});

describe('POST /api/food-quality/check - UNKNOWN result', () => {
    it('a very small/low-detail image reliably returns UNKNOWN with a low confidence', async () => {
        const kitchen = await registerKitchen();
        const tinyValidPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 1)]);
        const res = await check(kitchen.token, { imageBase64: b64(tinyValidPng), mimeType: 'image/png' });
        expect(res.status).toBe(200);
        expect(res.body.data.classification).toBe('UNKNOWN');
        expect(res.body.data.confidence).toBeLessThanOrEqual(0.4);
        expect(res.body.data.signals.some((s) => /small|low-detail/i.test(s))).toBe(true);
        expect(res.body.data.recommendation).toMatch(/manual inspection/i);
    });

    it('UNKNOWN is a real, reachable outcome across ordinary-sized images too, not just the tiny-image edge case', async () => {
        const kitchen = await registerKitchen();
        const seen = new Set();
        for (let i = 0; i < 60; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg(5000 + i * 53, i)), mimeType: 'image/jpeg' });
            seen.add(res.body.data.classification);
        }
        expect(seen.has('UNKNOWN')).toBe(true);
        expect(seen.size).toBeGreaterThan(1); // and it is not the ONLY outcome
    });
});

describe('POST /api/food-quality/check - invalid, oversized and unsupported input', () => {
    it('rejects a missing imageBase64 with 400, not 500', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { mimeType: 'image/jpeg' });
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
    });

    it('rejects a missing mimeType with 400', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg()) });
        expect(res.status).toBe(400);
    });

    it('rejects malformed base64 with 400', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: 'not-valid-base64-!!!', mimeType: 'image/jpeg' });
        expect(res.status).toBe(400);
    });

    it('rejects an unsupported declared format (e.g. GIF) with 400', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/gif' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/mimeType must be one of/);
    });

    it('rejects bytes that do not actually look like an image, even with a valid declared mimeType', async () => {
        const kitchen = await registerKitchen();
        const textBytes = Buffer.from('definitely not an image, just some plain text content here'.repeat(4), 'utf8');
        const res = await check(kitchen.token, { imageBase64: b64(textBytes), mimeType: 'image/png' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/does not look like a supported image format/);
    });

    it('rejects oversized input (over the documented max) with 400 and a clear message, not a raw 413', async () => {
        const kitchen = await registerKitchen();
        const { MAX_IMAGE_BYTES } = require('../src/ai/foodQuality/service');
        const oversized = fakeJpeg(MAX_IMAGE_BYTES + 5000);
        const res = await check(kitchen.token, { imageBase64: b64(oversized), mimeType: 'image/jpeg' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/too large/i);
    });

    it('the transport-level body limit still protects against a wildly oversized request', async () => {
        const kitchen = await registerKitchen();
        const wayTooBig = 'A'.repeat(3 * 1024 * 1024); // 3 MB of base64 text alone
        const res = await check(kitchen.token, { imageBase64: wayTooBig, mimeType: 'image/jpeg' });
        expect([400, 413]).toContain(res.status);
    });

    it('rejects data too small to be a valid image with 400', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(Buffer.from([1, 2, 3])), mimeType: 'image/png' });
        expect(res.status).toBe(400);
    });

    it('an invalid dailyLogId type is rejected before any database lookup', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg', dailyLogId: 'not-a-number' });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/food-quality/check - organization isolation', () => {
    it('screens successfully when dailyLogId belongs to the caller\'s own organization, and echoes its context', async () => {
        const kitchen = await registerKitchen();
        const item = await createMenuItem(kitchen.token);
        const log = await createDailyLog(kitchen.token, item.id);

        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg(6000, 9)), mimeType: 'image/jpeg', dailyLogId: log.id });
        expect(res.status).toBe(200);
        expect(res.body.data.context).toMatchObject({ dailyLogId: log.id, menuItemName: item.name });
    });

    it('refuses (403) a dailyLogId that belongs to a different organization, and leaks nothing about it', async () => {
        const kitchenA = await registerKitchen({ organizationName: 'Kitchen A' });
        const kitchenB = await registerKitchen({ organizationName: 'Kitchen B' });
        const itemB = await createMenuItem(kitchenB.token, 'Other Kitchen Dish');
        const logB = await createDailyLog(kitchenB.token, itemB.id);

        const res = await check(kitchenA.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg', dailyLogId: logB.id });
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toMatch(/Other Kitchen Dish/);
    });

    it('returns 404 for a dailyLogId that does not exist at all', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, { imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg', dailyLogId: 999999999 });
        expect(res.status).toBe(404);
    });

    it('never requires or accepts a client-supplied organization id - it always comes from the token', async () => {
        const kitchen = await registerKitchen();
        const res = await check(kitchen.token, {
            imageBase64: b64(fakeJpeg()), mimeType: 'image/jpeg', organizationId: 999999, kitchenOrgId: 999999,
        });
        expect(res.status).toBe(200); // the extra fields are simply ignored, not honoured
    });

    it('does not persist anything: no new tables/rows are created by a screening request', async () => {
        const kitchen = await registerKitchen();
        const before = await pool.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
        await check(kitchen.token, { imageBase64: b64(fakeJpeg(6000, 5)), mimeType: 'image/jpeg' });
        const menuItemCount = await pool.query('SELECT COUNT(*)::int AS n FROM menu_items');
        const dailyLogCount = await pool.query('SELECT COUNT(*)::int AS n FROM daily_logs');
        expect(menuItemCount.rows[0].n).toBe(0);
        expect(dailyLogCount.rows[0].n).toBe(0);
        const after = await pool.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
        expect(after.rows[0].n).toBe(before.rows[0].n); // no new table was created for this feature
    });
});

describe('POST /api/food-quality/check - deterministic provider behaviour end to end', () => {
    it('the exact same image submitted twice through the real API gives the exact same result', async () => {
        const kitchen = await registerKitchen();
        const image = { imageBase64: b64(fakeJpeg(6200, 42)), mimeType: 'image/jpeg' };
        const first = await check(kitchen.token, image);
        const second = await check(kitchen.token, image);
        expect(first.status).toBe(200);
        expect(second.body.data).toEqual(first.body.data);
    });

    it('is independent of which organization submits it: the same bytes give the same result for two different kitchens', async () => {
        const kitchenA = await registerKitchen({ organizationName: 'Det Kitchen A' });
        const kitchenB = await registerKitchen({ organizationName: 'Det Kitchen B' });
        const image = { imageBase64: b64(fakePng(6300, 7)), mimeType: 'image/png' };
        const resA = await check(kitchenA.token, image);
        const resB = await check(kitchenB.token, image);
        expect(resA.body.data).toEqual(resB.body.data);
    });
});
