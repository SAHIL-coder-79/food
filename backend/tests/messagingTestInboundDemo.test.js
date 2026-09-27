// Focused tests for the LOCAL MOCK WHATSAPP INBOUND FLOW's ergonomic additions: the simple { from, message }
// request shape, the richer { success, stage, pendingAction, listingId, surplus } response, and the
// TEST_MESSAGING_KITCHEN_USER_ID zero-setup demo identity shortcut. The underlying parser/confirmation/
// surplus-creation machinery this all sits on top of is already covered by tests/conversationalParser.test.js,
// tests/conversationalReducer.test.js and tests/messagingAssistantApi.test.js - this file does not repeat that.
const request = require('supertest');
const { app, pool, resetDb, registerKitchen } = require('./testHelpers');

const A = (token) => ({ Authorization: `Bearer ${token}` });

async function linkIdentity(token, externalUserId) {
    const res = await request(app).post('/api/messaging/identities').set(A(token)).send({ provider: 'mock', channel: 'whatsapp', externalUserId });
    expect(res.status).toBe(201);
}

const sendSimple = (from, message) => request(app).post('/api/messaging/test/inbound').send({ from, message });

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('Local mock WhatsApp inbound - simple {from, message} shape', () => {
    it('a valid surplus report creates a pending confirmation - the surplus is NOT created yet', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-1');

        const res = await sendSimple('demo-kitchen-whatsapp-1', 'We have 20 boxes of rice meals left, good for 3 hours');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.stage).toBe('awaiting_confirmation');
        expect(res.body.message).toMatch(/20 boxes/);
        expect(res.body.message).toMatch(/Safe for: 3 hours/);
        expect(res.body.pendingAction).toEqual({ type: 'CREATE_SURPLUS', quantity: 20, unit: 'boxes', foodItem: 'rice meals', safeForHours: 3 });

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('supports the documented sentence variants', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-2');
        const variants = ['20 boxes rice meals, good for 3 hours', '20 boxes of rice meals left, safe for 3 hours'];
        for (const text of variants) {
            // eslint-disable-next-line no-await-in-loop
            const res = await sendSimple('demo-kitchen-whatsapp-2', text);
            expect(res.body.stage).toBe('awaiting_confirmation');
            expect(res.body.pendingAction.quantity).toBe(20);
            expect(res.body.pendingAction.foodItem).toBe('rice meals');
            expect(res.body.pendingAction.safeForHours).toBe(3);
        }
    });

    it('YES after a valid pending action creates a REAL surplus via the existing surplus service', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-3');
        await sendSimple('demo-kitchen-whatsapp-3', 'We have 20 boxes of rice meals left, good for 3 hours');

        const res = await sendSimple('demo-kitchen-whatsapp-3', 'YES');
        expect(res.status).toBe(200);
        expect(res.body.stage).toBe('created');
        expect(res.body.message).toMatch(/Surplus created/);
        expect(typeof res.body.listingId).toBe('number');
        expect(res.body.surplus).toMatchObject({ quantity: 20, status: 'Available' });

        // The EXISTING surplus API (the same one the web dashboard calls) now shows this exact listing.
        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(1);
        expect(listings.body.listings[0].id).toBe(res.body.listingId);
        expect(listings.body.listings[0].food_type).toMatch(/rice meals/);
        expect(listings.body.listings[0].status).toBe('Available');
    });

    it('NO cancels the pending action - nothing is created', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-4');
        await sendSimple('demo-kitchen-whatsapp-4', 'We have 20 boxes of rice meals left, good for 3 hours');

        const res = await sendSimple('demo-kitchen-whatsapp-4', 'NO');
        expect(res.body.stage).toBe('cancelled');

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('YES with no pending action returns a clear, safe response and creates nothing', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-5');

        const res = await sendSimple('demo-kitchen-whatsapp-5', 'YES');
        expect(res.body.stage).toBe('nothing_to_confirm');
        expect(res.body.message).toMatch(/nothing pending to confirm/i);

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('an unparseable/invalid message gets a clear, actionable response, not a crash', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-6');

        const res = await sendSimple('demo-kitchen-whatsapp-6', 'good morning, lovely weather today');
        expect(res.status).toBe(200);
        expect(res.body.stage).toBe('unknown');
        expect(res.body.message).toMatch(/didn't understand/i);
    });

    it('a message missing the safe-duration asks for it specifically, keeping what was already understood', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-7');
        const res = await sendSimple('demo-kitchen-whatsapp-7', '20 boxes of rice meals');
        expect(res.body.stage).toBe('collecting');
        expect(res.body.message).toMatch(/how long is it safe to keep/i);
        expect(res.body.pendingAction.quantity).toBe(20);
        expect(res.body.pendingAction.foodItem).toBe('rice meals');
        expect(res.body.pendingAction.safeForHours).toBeNull();
    });

    it('a different sender cannot confirm another sender\'s pending action', async () => {
        const kitchenA = await registerKitchen({ organizationName: 'Demo Kitchen A' });
        const kitchenB = await registerKitchen({ organizationName: 'Demo Kitchen B' });
        await linkIdentity(kitchenA.token, 'demo-kitchen-whatsapp-a');
        await linkIdentity(kitchenB.token, 'demo-kitchen-whatsapp-b');

        await sendSimple('demo-kitchen-whatsapp-a', 'We have 20 boxes of rice meals left, good for 3 hours');
        const res = await sendSimple('demo-kitchen-whatsapp-b', 'YES'); // B has no pending action of its own
        expect(res.body.stage).toBe('nothing_to_confirm');

        const listingsA = await request(app).get('/api/surplus-listings').set(A(kitchenA.token));
        const listingsB = await request(app).get('/api/surplus-listings').set(A(kitchenB.token));
        expect(listingsA.body.listings).toHaveLength(0); // A's own report is still only pending, not confirmed
        expect(listingsB.body.listings).toHaveLength(0);
    });

    it('a pending action expires after its TTL and can no longer be confirmed', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-8');
        await sendSimple('demo-kitchen-whatsapp-8', 'We have 20 boxes of rice meals left, good for 3 hours');

        // Simulate time passing well beyond MESSAGING_SESSION_TTL_MINUTES.
        await pool.query(
            `UPDATE conversation_sessions SET expires_at = NOW() - INTERVAL '1 hour'
             WHERE messaging_identity_id = (SELECT id FROM messaging_identities WHERE external_user_id = $1)`,
            ['demo-kitchen-whatsapp-8']
        );

        const res = await sendSimple('demo-kitchen-whatsapp-8', 'YES');
        expect(res.body.stage).toBe('nothing_to_confirm');

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('an unrecognised sender is refused and can never create or claim anything (no anonymous claiming)', async () => {
        const res = await sendSimple('totally-unknown-number', 'We have 20 boxes of rice meals left, good for 3 hours');
        expect(res.status).toBe(200);
        expect(res.body.stage).toBe('not_linked');
    });

    it('never accepts organizationId/userId/role/ngoId/claimedBy from the request body', async () => {
        const kitchenA = await registerKitchen({ organizationName: 'Trusted Kitchen' });
        const outsiderOrgId = kitchenA.organization.id + 999999;
        await linkIdentity(kitchenA.token, 'demo-kitchen-whatsapp-spoof');

        await request(app)
            .post('/api/messaging/test/inbound')
            .send({
                from: 'demo-kitchen-whatsapp-spoof',
                message: 'We have 20 boxes of rice meals left, good for 3 hours',
                organizationId: outsiderOrgId,
                userId: 999999,
                role: 'SYSTEM_ADMIN',
                ngoId: 42,
                claimedBy: 999999,
            });
        const confirm = await request(app)
            .post('/api/messaging/test/inbound')
            .send({ from: 'demo-kitchen-whatsapp-spoof', message: 'YES', organizationId: outsiderOrgId });

        expect(confirm.body.stage).toBe('created');
        const listings = await request(app).get('/api/surplus-listings').set(A(kitchenA.token));
        expect(listings.body.listings[0].kitchen_org_id).toBe(kitchenA.organization.id); // never the spoofed org
    });

    it('the existing full normalized-envelope shape keeps working unchanged alongside the new simple shape', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-9');
        const res = await request(app)
            .post('/api/messaging/test/inbound')
            .send({ provider: 'mock', channel: 'whatsapp', sender: { externalId: 'demo-kitchen-whatsapp-9' }, message: { id: 'env-1', text: 'help' } });
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toMatch(/FoodShare Assistant/); // original Task 20/21 response shape intact
        expect(res.body.stage).toBe('help'); // the new field is present here too
    });

    it('this endpoint never bypasses the real surplus service\'s own validation (no direct DB manipulation)', async () => {
        // A behavioural proxy for "the confirmation handler calls the existing domain service, not a shortcut
        // that writes rows itself": an invalid quantity (0) is rejected at confirmation time by
        // surplusListingService's own validation, exactly as a web-form submission would be - not silently
        // written to the database.
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, 'demo-kitchen-whatsapp-10');
        await sendSimple('demo-kitchen-whatsapp-10', 'We have 0 boxes of rice meals left, good for 3 hours');

        const confirm = await sendSimple('demo-kitchen-whatsapp-10', 'YES');
        expect(confirm.body.stage).toBe('creation_failed');
        expect(confirm.body.listingId).toBeUndefined();

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });
});

describe('TEST_MESSAGING_KITCHEN_USER_ID - zero-setup demo identity (local development only)', () => {
    it('auto-links an unrecognised sender to the configured demo kitchen user on first contact', async () => {
        const kitchen = await registerKitchen({ organizationName: 'Env Demo Kitchen' });
        const saved = { ...process.env };
        process.env.TEST_MESSAGING_KITCHEN_USER_ID = String(kitchen.user.id);
        let isolatedApp;
        let isolatedPool;
        jest.isolateModules(() => {
            // eslint-disable-next-line global-require
            isolatedApp = require('../src/app');
            // eslint-disable-next-line global-require
            isolatedPool = require('../src/models/db');
        });
        process.env = saved;

        try {
            const res = await request(isolatedApp)
                .post('/api/messaging/test/inbound')
                .send({ from: 'demo-kitchen-whatsapp', message: 'We have 20 boxes of rice meals left, good for 3 hours' });
            expect(res.status).toBe(200);
            expect(res.body.stage).toBe('awaiting_confirmation');

            const confirmRes = await request(isolatedApp).post('/api/messaging/test/inbound').send({ from: 'demo-kitchen-whatsapp', message: 'YES' });
            expect(confirmRes.body.stage).toBe('created');

            const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
            expect(listings.body.listings).toHaveLength(1);
            expect(listings.body.listings[0].id).toBe(confirmRes.body.listingId);
        } finally {
            await isolatedPool.end();
        }
    });

    it('never applies when NODE_ENV=production - the whole endpoint is refused with 404 regardless', async () => {
        const kitchen = await registerKitchen({ organizationName: 'Env Demo Kitchen Prod' });
        const saved = { ...process.env };
        process.env.TEST_MESSAGING_KITCHEN_USER_ID = String(kitchen.user.id);
        process.env.NODE_ENV = 'production';
        let isolatedApp;
        let isolatedPool;
        jest.isolateModules(() => {
            // eslint-disable-next-line global-require
            isolatedApp = require('../src/app');
            // eslint-disable-next-line global-require
            isolatedPool = require('../src/models/db');
        });
        process.env = saved;

        try {
            const res = await request(isolatedApp).post('/api/messaging/test/inbound').send({ from: 'demo-kitchen-whatsapp-prod', message: 'help' });
            expect(res.status).toBe(404);
        } finally {
            await isolatedPool.end();
        }
    });

    it('fails open (ordinary "not linked" reply, no crash) when the configured user id does not exist', async () => {
        const saved = { ...process.env };
        process.env.TEST_MESSAGING_KITCHEN_USER_ID = '999999999';
        let isolatedApp;
        let isolatedPool;
        jest.isolateModules(() => {
            // eslint-disable-next-line global-require
            isolatedApp = require('../src/app');
            // eslint-disable-next-line global-require
            isolatedPool = require('../src/models/db');
        });
        process.env = saved;

        try {
            const res = await request(isolatedApp).post('/api/messaging/test/inbound').send({ from: 'demo-kitchen-whatsapp-bad', message: 'help' });
            expect(res.status).toBe(200);
            // The configured id doesn't exist, so ensureDemoIdentityIfConfigured fails open (creates nothing) -
            // the sender is correctly treated as still unrecognised, exactly as if no shortcut were configured.
            expect(res.body.stage).toBe('not_linked');
        } finally {
            await isolatedPool.end();
        }
    });
});
