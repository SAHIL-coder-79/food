const crypto = require('crypto');

const META_ENV = {
    MESSAGING_ENABLED: 'true',
    MESSAGING_PROVIDER: 'meta',
    META_WHATSAPP_VERIFY_TOKEN: 'e2e-verify-token',
    META_WHATSAPP_APP_SECRET: 'e2e-app-secret',
    META_WHATSAPP_ACCESS_TOKEN: 'e2e-access-token',
    META_WHATSAPP_PHONE_NUMBER_ID: '999888777',
};

let request;
let app;
let pool;

beforeAll(() => {
    // A real, isolated app instance with MESSAGING_PROVIDER=meta actually configured - config/env.js is only
    // ever evaluated once per process normally, so this is the same jest.isolateModules technique already used
    // elsewhere in this suite (e.g. demoProductionGuard.test.js) to exercise a different configuration.
    const saved = { ...process.env };
    Object.assign(process.env, META_ENV);
    jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        request = require('supertest');
        // eslint-disable-next-line global-require
        app = require('../src/app');
        // eslint-disable-next-line global-require
        pool = require('../src/models/db');
    });
    process.env = saved;
});

afterAll(async () => {
    await pool.end();
});

beforeEach(async () => {
    await pool.query(
        `TRUNCATE TABLE notifications, transactions_log, surplus_listings, daily_logs, menu_items,
         conversation_sessions, messaging_inbound_log, messaging_link_requests, messaging_identities,
         users, organizations RESTART IDENTITY CASCADE`
    );
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.OUT' }] }) });
});

const A = (token) => ({ Authorization: `Bearer ${token}` });

async function registerKitchen(name = 'Meta Test Kitchen') {
    const email = `kitchen-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await request(app)
        .post('/api/auth/register-organization')
        .send({ organizationName: name, organizationType: 'kitchen', pincode: '123456', name: 'Manager', email, password: 'password123' });
    expect(res.status).toBe(201);
    return res.body;
}

function sign(rawJson) {
    return `sha256=${crypto.createHmac('sha256', META_ENV.META_WHATSAPP_APP_SECRET).update(rawJson).digest('hex')}`;
}

function metaTextPayload({ from, id, text, timestamp = String(Math.floor(Date.now() / 1000)) }) {
    return JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
            {
                id: 'waba-1',
                changes: [
                    {
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: { phone_number_id: META_ENV.META_WHATSAPP_PHONE_NUMBER_ID },
                            contacts: [{ profile: { name: 'Test' }, wa_id: from }],
                            messages: [{ from, id, timestamp, type: 'text', text: { body: text } }],
                        },
                        field: 'messages',
                    },
                ],
            },
        ],
    });
}

function metaImagePayload({ from, id }) {
    return JSON.stringify({
        entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media1' } }] } }] }],
    });
}

function metaStatusPayload() {
    return JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.STATUS', status: 'delivered' }] }, field: 'messages' }] }] });
}

async function sendSignedWebhook(rawJson) {
    return request(app).post('/api/messaging/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(rawJson)).send(rawJson);
}

let msgCounter = 0;
const nextId = () => {
    msgCounter += 1;
    return `wamid.MSG${msgCounter}`;
};

describe('GET /api/messaging/webhook - Meta subscription verification', () => {
    it('echoes the challenge for a correct verify token', async () => {
        const res = await request(app).get('/api/messaging/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'e2e-verify-token', 'hub.challenge': '424242' });
        expect(res.status).toBe(200);
        expect(res.text).toBe('424242');
    });

    it('rejects an incorrect verify token', async () => {
        const res = await request(app).get('/api/messaging/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' });
        expect(res.status).toBe(403);
    });

    it('rejects a missing hub.mode', async () => {
        const res = await request(app).get('/api/messaging/webhook').query({ 'hub.verify_token': 'e2e-verify-token', 'hub.challenge': '1' });
        expect(res.status).toBe(403);
    });
});

describe('POST /api/messaging/webhook - signature validation', () => {
    it('accepts a correctly signed payload', async () => {
        const raw = metaTextPayload({ from: '19998887777', id: nextId(), text: 'help' });
        const res = await sendSignedWebhook(raw);
        expect(res.status).toBe(200);
    });

    it('rejects an invalid signature', async () => {
        const raw = metaTextPayload({ from: '19998887777', id: nextId(), text: 'help' });
        const res = await request(app).post('/api/messaging/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send(raw);
        expect(res.status).toBe(401);
    });

    it('rejects a missing signature header', async () => {
        const raw = metaTextPayload({ from: '19998887777', id: nextId(), text: 'help' });
        const res = await request(app).post('/api/messaging/webhook').set('Content-Type', 'application/json').send(raw);
        expect(res.status).toBe(401);
    });

    it('rejects a body modified after signing', async () => {
        const original = metaTextPayload({ from: '19998887777', id: nextId(), text: 'help' });
        const signature = sign(original);
        const tampered = metaTextPayload({ from: '19998887777', id: nextId(), text: 'a completely different message' });
        const res = await request(app).post('/api/messaging/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(tampered);
        expect(res.status).toBe(401);
    });

    it('never echoes the app secret or signature in an error response', async () => {
        const raw = metaTextPayload({ from: '1', id: nextId(), text: 'help' });
        const res = await request(app).post('/api/messaging/webhook').set('Content-Type', 'application/json').send(raw);
        expect(JSON.stringify(res.body)).not.toMatch(/e2e-app-secret/);
    });
});

describe('POST /api/messaging/webhook - unknown sender and unsupported message types', () => {
    it('refuses an unknown sender', async () => {
        const raw = metaTextPayload({ from: '19998880000', id: nextId(), text: 'We have 4 boxes of rice meals left, good for 2 hours' });
        const res = await sendSignedWebhook(raw);
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toMatch(/not linked/i);
    });

    it('a status-only (delivery receipt) callback is acknowledged and ignored, not processed as a message', async () => {
        const raw = metaStatusPayload();
        const res = await sendSignedWebhook(raw);
        expect(res.status).toBe(200);
        expect(res.body.data.ignored).toBe(true);
    });

    it('an unsupported message type (image) gets a clear, safe response and never crashes the webhook', async () => {
        const kitchen = await registerKitchen();
        const waNumber = '19998887778';
        const linkReqRes = await request(app).post('/api/messaging/link-requests').set(A(kitchen.token)).send({ provider: 'meta', channel: 'whatsapp' });
        await sendSignedWebhook(metaTextPayload({ from: waNumber, id: nextId(), text: linkReqRes.body.data.code }));

        const raw = metaImagePayload({ from: waNumber, id: nextId() });
        const res = await sendSignedWebhook(raw);
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toMatch(/support text messages/i);
    });
});

describe('The full real-shaped Meta conversation flow (Task 21 Part 11 / acceptance criteria)', () => {
    it('link -> report -> confirm -> real surplus -> enters the existing rescue pipeline', async () => {
        const kitchen = await registerKitchen();
        const waNumber = '14085551234';

        // Step 1: authenticated user requests a linking code (never trusts a WhatsApp message to self-link).
        const linkReqRes = await request(app)
            .post('/api/messaging/link-requests')
            .set(A(kitchen.token))
            .send({ provider: 'meta', channel: 'whatsapp' });
        expect(linkReqRes.status).toBe(201);
        const code = linkReqRes.body.data.code;
        expect(code).toMatch(/^FS-[A-Z0-9]{6}$/);

        // Step 2: the WhatsApp user proves control of the number by sending the code, via a real, signed webhook.
        const linkMsg = metaTextPayload({ from: waNumber, id: nextId(), text: code });
        const linkRes = await sendSignedWebhook(linkMsg);
        expect(linkRes.status).toBe(200);
        expect(linkRes.body.data.reply).toMatch(/now linked/i);

        // Step 3: report surplus, in the exact wording from the acceptance criteria.
        const reportMsg = metaTextPayload({ from: waNumber, id: nextId(), text: 'We have 20 boxes of rice meals left, good for 3 hours' });
        const reportRes = await sendSignedWebhook(reportMsg);
        expect(reportRes.status).toBe(200);
        expect(reportRes.body.data.reply).toMatch(/20 boxes/);
        expect(reportRes.body.data.reply).toMatch(/Safe for: 3 hours/);
        expect(reportRes.body.data.reply).toMatch(/Reply YES to confirm or NO to cancel/);

        // Step 4: confirm.
        const confirmMsg = metaTextPayload({ from: waNumber, id: nextId(), text: 'YES' });
        const confirmRes = await sendSignedWebhook(confirmMsg);
        expect(confirmRes.status).toBe(200);
        expect(confirmRes.body.data.reply).toMatch(/✅ Surplus created/);
        expect(confirmRes.body.data.reply).toMatch(/rescue workflow/i);

        // Step 5: the EXISTING surplus API shows the real listing - the existing rescue pipeline owns it now.
        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.status).toBe(200);
        expect(listings.body.listings).toHaveLength(1);
        expect(listings.body.listings[0].status).toBe('Available');
        expect(listings.body.listings[0].food_type).toMatch(/rice meals/);
        expect(listings.body.listings[0].quantity).toBe(20);
    });

    it('idempotency: the exact same Meta message id delivered twice never creates two listings', async () => {
        const kitchen = await registerKitchen();
        const waNumber = '14085559999';
        const linkReqRes = await request(app).post('/api/messaging/link-requests').set(A(kitchen.token)).send({ provider: 'meta', channel: 'whatsapp' });
        await sendSignedWebhook(metaTextPayload({ from: waNumber, id: nextId(), text: linkReqRes.body.data.code }));
        await sendSignedWebhook(metaTextPayload({ from: waNumber, id: nextId(), text: '20 boxes of rice meals, good for 3 hours' }));

        const confirmId = nextId();
        const first = await sendSignedWebhook(metaTextPayload({ from: waNumber, id: confirmId, text: 'YES' }));
        expect(first.body.data.reply).toMatch(/Surplus created/);

        // Meta re-delivers the identical webhook (same message id) - a real, documented occurrence.
        const replay = await sendSignedWebhook(metaTextPayload({ from: waNumber, id: confirmId, text: 'YES' }));
        expect(replay.body.data.duplicate).toBe(true);

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(1);
    });
});

describe('Secure identity linking - security properties', () => {
    it('rejects an invalid/unknown linking code', async () => {
        const raw = metaTextPayload({ from: '14085551111', id: nextId(), text: 'FS-ZZZZZZ' });
        const res = await sendSignedWebhook(raw);
        expect(res.body.data.reply).toMatch(/isn't valid or has expired/i);
    });

    it('rejects an expired linking code', async () => {
        const kitchen = await registerKitchen();
        const linkReqRes = await request(app).post('/api/messaging/link-requests').set(A(kitchen.token)).send({ provider: 'meta', channel: 'whatsapp' });
        const code = linkReqRes.body.data.code;
        // Force it into the past directly - simulating time passing beyond MESSAGING_LINK_REQUEST_TTL_MINUTES.
        await pool.query('UPDATE messaging_link_requests SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE code = $1', [code]);

        const res = await sendSignedWebhook(metaTextPayload({ from: '14085552222', id: nextId(), text: code }));
        expect(res.body.data.reply).toMatch(/isn't valid or has expired/i);

        const check = await pool.query('SELECT user_id FROM messaging_identities WHERE external_user_id = $1', ['14085552222']);
        expect(check.rows).toHaveLength(0);
    });

    it('prevents reuse: a code already redeemed once cannot be redeemed again by a different number', async () => {
        const kitchen = await registerKitchen();
        const linkReqRes = await request(app).post('/api/messaging/link-requests').set(A(kitchen.token)).send({ provider: 'meta', channel: 'whatsapp' });
        const code = linkReqRes.body.data.code;

        const first = await sendSignedWebhook(metaTextPayload({ from: '14085553333', id: nextId(), text: code }));
        expect(first.body.data.reply).toMatch(/now linked/i);

        const second = await sendSignedWebhook(metaTextPayload({ from: '14085554444', id: nextId(), text: code }));
        expect(second.body.data.reply).toMatch(/isn't valid or has expired/i);

        const identities = await pool.query('SELECT external_user_id FROM messaging_identities WHERE user_id = $1', [kitchen.user.id]);
        expect(identities.rows).toHaveLength(1);
        expect(identities.rows[0].external_user_id).toBe('14085553333');
    });

    it('prevents identity takeover: a fresh, valid code cannot be redeemed against a number already linked to someone else', async () => {
        const kitchenA = await registerKitchen('Kitchen A Meta');
        const kitchenB = await registerKitchen('Kitchen B Meta');
        const sharedNumber = '14085555555';

        const codeAReq = await request(app).post('/api/messaging/link-requests').set(A(kitchenA.token)).send({ provider: 'meta', channel: 'whatsapp' });
        await sendSignedWebhook(metaTextPayload({ from: sharedNumber, id: nextId(), text: codeAReq.body.data.code }));

        const codeBReq = await request(app).post('/api/messaging/link-requests').set(A(kitchenB.token)).send({ provider: 'meta', channel: 'whatsapp' });
        const attempt = await sendSignedWebhook(metaTextPayload({ from: sharedNumber, id: nextId(), text: codeBReq.body.data.code }));
        expect(attempt.body.data.reply).toMatch(/already linked/i);

        const identity = await pool.query('SELECT user_id FROM messaging_identities WHERE external_user_id = $1', [sharedNumber]);
        expect(identity.rows[0].user_id).toBe(kitchenA.user.id);
    });

    it('link-requests endpoint requires authentication', async () => {
        const res = await request(app).post('/api/messaging/link-requests').send({ provider: 'meta', channel: 'whatsapp' });
        expect(res.status).toBe(401);
    });

    it('the real Meta provider refuses direct self-claim linking (POST /identities) - only the code flow works', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .post('/api/messaging/identities')
            .set(A(kitchen.token))
            .send({ provider: 'meta', channel: 'whatsapp', externalUserId: '14085556666' });
        expect(res.status).toBe(400);
    });
});
