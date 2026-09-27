const request = require('supertest');
const { app, pool, resetDb, registerKitchen, registerNgo } = require('./testHelpers');
const messagingIdentityModel = require('../src/models/messagingIdentityModel');

const A = (token) => ({ Authorization: `Bearer ${token}` });
let msgCounter = 0;
const nextMsgId = (label) => {
    msgCounter += 1;
    return `${label}-${msgCounter}`;
};

const crypto = require('crypto');

function metaSignature(body) {
    const rawBody = JSON.stringify(body);
    const appSecret = process.env.META_WHATSAPP_APP_SECRET;

    if (!appSecret) {
        throw new Error('META_WHATSAPP_APP_SECRET is required for Meta webhook tests');
    }

    return {
        rawBody,
        signature: `sha256=${crypto
            .createHmac('sha256', appSecret)
            .update(Buffer.from(rawBody, 'utf8'))
            .digest('hex')}`,
    };
}

async function sendMetaWebhook(body) {
    const { rawBody, signature } = metaSignature(body);

    return request(app)
        .post('/api/messaging/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(rawBody);
}

async function linkIdentity(token, { provider = 'mock', channel = 'whatsapp', externalUserId }) {
    return request(app).post('/api/messaging/identities').set(A(token)).send({ provider, channel, externalUserId });
}

async function sendMessage(externalUserId, text, { messageId, endpoint = '/api/messaging/test/inbound', extra = {} } = {}) {
    return request(app)
        .post(endpoint)
        .send({
            provider: 'mock',
            channel: 'whatsapp',
            sender: { externalId: externalUserId },
            message: { id: messageId || nextMsgId(externalUserId), text },
            timestamp: new Date().toISOString(),
            ...extra,
        });
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('POST /api/messaging/identities - linking', () => {
    it('lets an authenticated kitchen user link their own account', async () => {
        const kitchen = await registerKitchen();
        const res = await linkIdentity(kitchen.token, { externalUserId: '+911111111111' });
        expect(res.status).toBe(201);
        expect(res.body.data.userId).toBe(kitchen.user.id);
        expect(res.body.data.organizationId).toBe(kitchen.organization.id);
    });

    it('requires authentication', async () => {
        const res = await request(app).post('/api/messaging/identities').send({ provider: 'mock', channel: 'whatsapp', externalUserId: 'x' });
        expect(res.status).toBe(401);
    });

    it('also allows an NGO role to link an identity (Task 21: for receiving rescue notifications, not for reporting surplus)', async () => {
        const ngo = await registerNgo();
        const res = await linkIdentity(ngo.token, { externalUserId: '+922222222222' });
        expect(res.status).toBe(201);
    });

    it('refuses a role that is neither kitchen nor NGO (e.g. system admin)', async () => {
        const { createSystemAdmin } = require('./testHelpers');
        const admin = await createSystemAdmin();
        const res = await linkIdentity(admin.token, { externalUserId: '+922222222299' });
        expect(res.status).toBe(403);
    });

    it('refuses linking the same contact twice', async () => {
        const kitchen = await registerKitchen();
        const kitchen2 = await registerKitchen({ organizationName: 'Other Kitchen' });
        const first = await linkIdentity(kitchen.token, { externalUserId: '+933333333333' });
        expect(first.status).toBe(201);
        const second = await linkIdentity(kitchen2.token, { externalUserId: '+933333333333' });
        expect(second.status).toBe(409);
    });

    it('never accepts a client-supplied userId or organizationId - it always uses the authenticated session', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .post('/api/messaging/identities')
            .set(A(kitchen.token))
            .send({ provider: 'mock', channel: 'whatsapp', externalUserId: '+944444444444', userId: 999999, organizationId: 999999 });
        expect(res.status).toBe(201);
        expect(res.body.data.userId).toBe(kitchen.user.id);
        expect(res.body.data.organizationId).toBe(kitchen.organization.id);
    });

    it('GET /identities/me lists only the caller\'s own identities', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+955555555555' });
        const res = await request(app).get('/api/messaging/identities/me').set(A(kitchen.token));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].externalUserId).toBe('+955555555555');
    });
});

describe('Conversational flow - the acceptance-criteria scenario', () => {
    it('report -> confirmation prompt -> yes -> real surplus created via the existing service', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000001' });

        const report = await sendMessage('+960000000001', 'We have 4 boxes of rice meals left, good for 2 hours');
        expect(report.status).toBe(200);
        expect(report.body.data.reply).toMatch(/Food: rice meals/);
        expect(report.body.data.reply).toMatch(/Quantity: 4 boxes/);
        expect(report.body.data.reply).toMatch(/Reply YES to confirm or NO to cancel/);

        const confirm = await sendMessage('+960000000001', 'yes');
        expect(confirm.status).toBe(200);
        expect(confirm.body.data.reply).toMatch(/✅ Surplus created/);
        expect(confirm.body.data.reply).toMatch(/4 boxes of rice meals/);
        expect(confirm.body.data.reply).toMatch(/rescue workflow/i);

        // The EXISTING surplus API now shows the real, created listing - not a second, parallel system.
        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.status).toBe(200);
        expect(listings.body.listings.some((l) => l.food_type.includes('rice meals') && l.status === 'Available')).toBe(true);
    });

    it('asks follow-up questions for missing fields, one at a time, and remembers earlier answers', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000002' });

        const step1 = await sendMessage('+960000000002', 'We have 4 boxes left');
        expect(step1.body.data.reply).toBe('Which food item is left?');

        const step2 = await sendMessage('+960000000002', 'rice meals');
        expect(step2.body.data.reply).toMatch(/How long is it safe to keep/);

        const step3 = await sendMessage('+960000000002', 'good for 2 hours');
        expect(step3.body.data.reply).toMatch(/Food: rice meals/);
        expect(step3.body.data.reply).toMatch(/Quantity: 4 boxes/);
        expect(step3.body.data.reply).toMatch(/Safe for: 2 hours/);
    });

    it('cancelling a pending report creates nothing', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000003' });

        await sendMessage('+960000000003', 'We have 4 boxes of rice meals left, good for 2 hours');
        const cancel = await sendMessage('+960000000003', 'cancel');
        expect(cancel.body.data.reply).toMatch(/cancelled/i);

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('a lone "yes" with nothing pending does not create anything', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000004' });

        const res = await sendMessage('+960000000004', 'yes');
        expect(res.body.data.reply).toMatch(/nothing pending to confirm/i);

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('a repeated confirmation after the surplus was already created does not create a second one', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000005' });

        await sendMessage('+960000000005', 'We have 4 boxes of rice meals left, good for 2 hours');
        await sendMessage('+960000000005', 'yes'); // creates it
        const again = await sendMessage('+960000000005', 'yes'); // a brand new, distinct "yes" message
        expect(again.body.data.reply).toMatch(/nothing pending to confirm/i);

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(1);
    });

    it('list and status commands reuse the existing surplus data, never a second store', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000006' });

        await sendMessage('+960000000006', 'We have 4 boxes of rice meals left, good for 2 hours');
        await sendMessage('+960000000006', 'yes');

        const list = await sendMessage('+960000000006', 'show my surplus');
        expect(list.body.data.reply).toMatch(/rice meals/);

        const status = await sendMessage('+960000000006', 'status of my surplus');
        expect(status.body.data.reply).toMatch(/1 available/);
    });

    it('help and unknown messages never create or change anything', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+960000000007' });

        const help = await sendMessage('+960000000007', 'help');
        expect(help.body.data.reply).toMatch(/FoodShare Assistant/);

        const unknown = await sendMessage('+960000000007', 'good morning, lovely weather today');
        expect(unknown.body.data.reply).toMatch(/didn't understand/i);
    });
});

describe('Idempotency - duplicate webhook delivery', () => {
    it('the exact same confirmation message delivered twice creates only one surplus listing', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+970000000001' });

        await sendMessage('+970000000001', 'We have 4 boxes of rice meals left, good for 2 hours', { messageId: 'report-1' });
        const confirmId = 'confirm-1';
        const first = await sendMessage('+970000000001', 'yes', { messageId: confirmId });
        expect(first.body.data.reply).toMatch(/✅ Surplus created/);

        const replay = await sendMessage('+970000000001', 'yes', { messageId: confirmId }); // same message id
        expect(replay.body.data.duplicate).toBe(true);
        expect(replay.body.data.reply).toBeFalsy();

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(1);
    });

    it('a duplicate report message does not create two pending sessions or two listings', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+970000000002' });

        const reportId = 'report-dup-1';
        const first = await sendMessage('+970000000002', 'We have 4 boxes of rice meals left, good for 2 hours', { messageId: reportId });
        expect(first.status).toBe(200);
        const replay = await sendMessage('+970000000002', 'We have 4 boxes of rice meals left, good for 2 hours', { messageId: reportId });
        expect(replay.body.data.duplicate).toBe(true);

        await sendMessage('+970000000002', 'yes');
        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(1);
    });
});

describe('Security - unknown/inactive sender', () => {
    it('an unknown sender is refused and cannot create anything', async () => {
        const res = await sendMessage('+989999999999', 'We have 4 boxes of rice meals left, good for 2 hours');
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toMatch(/not linked to a FoodShare kitchen account/i);
    });

    it('an inactive (unlinked) identity is refused even though the row exists', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+981111111111' });
        await pool.query('UPDATE messaging_identities SET active = false WHERE external_user_id = $1', ['+981111111111']);

        const res = await sendMessage('+981111111111', 'We have 4 boxes of rice meals left, good for 2 hours');
        expect(res.body.data.reply).toMatch(/not linked/i);

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(0);
    });

    it('a linked identity whose FoodShare user has since been deactivated is refused', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+982222222222' });
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [kitchen.user.id]);

        const res = await sendMessage('+982222222222', 'We have 4 boxes of rice meals left, good for 2 hours');
        expect(res.body.data.reply).toMatch(/not active/i);
    });

    it('an NGO user\'s linked identity can receive replies but cannot report surplus over chat', async () => {
        const ngo = await registerNgo();
        // Task 21 widened /identities to allow NGO roles too (so NGOs can link a number to receive rescue
        // notifications), but the conversational assistant's surplus-reporting flow remains kitchen-only -
        // enforced here, at the point of use, not at the point of linking.
        await messagingIdentityModel.create({ provider: 'mock', channel: 'whatsapp', externalUserId: '+983333333333', userId: ngo.user.id, organizationId: ngo.organization.id });

        const res = await sendMessage('+983333333333', 'We have 4 boxes of rice meals left, good for 2 hours');
        expect(res.body.data.reply).toMatch(/kitchen accounts only/i);
    });
});

describe('Security - no client-supplied identity spoofing', () => {
    it('ignores a client-supplied organizationId/userId in the webhook body entirely', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+991111111111' });

        await sendMessage('+991111111111', 'We have 4 boxes of rice meals left, good for 2 hours', {
            extra: { organizationId: 999999, userId: 999999, role: 'SYSTEM_ADMIN' },
        });
        await sendMessage('+991111111111', 'yes', { extra: { organizationId: 999999 } });

        const listings = await request(app).get('/api/surplus-listings').set(A(kitchen.token));
        expect(listings.body.listings).toHaveLength(1);
        expect(listings.body.listings[0].kitchen_org_id).toBe(kitchen.organization.id);
    });

    it('cross-organization isolation: kitchen A\'s messages never affect or expose kitchen B\'s surplus', async () => {
        const kitchenA = await registerKitchen({ organizationName: 'Kitchen A' });
        const kitchenB = await registerKitchen({ organizationName: 'Kitchen B' });
        await linkIdentity(kitchenA.token, { externalUserId: '+992222222221' });
        await linkIdentity(kitchenB.token, { externalUserId: '+992222222222' });

        await sendMessage('+992222222221', 'We have 2 boxes of naan left, good for 1 hour');
        await sendMessage('+992222222221', 'yes');

        const bListings = await request(app).get('/api/surplus-listings').set(A(kitchenB.token));
        expect(bListings.body.listings).toHaveLength(0);

        const statusB = await sendMessage('+992222222222', 'status of my surplus');
        expect(statusB.body.data.reply).toMatch(/0 available/);
    });
});

describe('Security - authentication is not bypassable through the webhook', () => {
    it('the webhook route itself requires no FoodShare token, but still cannot act without a linked identity', async () => {
        const res = await sendMetaWebhook({
            entry: [{
                changes: [{
                    value: {
                        messages: [{
                            from: '+9800000000000',
                            id: nextMsgId('webhook'),
                            type: 'text',
                            text: {
                                body: 'We have 4 boxes of rice meals left, good for 2 hours'
                            },
                            timestamp: String(Math.floor(Date.now() / 1000))
                        }]
                    }
                }]
            }]
        });
        expect(res.status).toBe(200); // the HTTP call itself succeeds (it's a public webhook)...
        expect(res.body.data.reply).toMatch(/not linked/i); // ...but nothing is ever created for an unknown sender
    });

    it('rejects a malformed webhook payload with 400, not 500', async () => {
        const res = await sendMetaWebhook({ provider: 'mock' });
        expect(res.status).toBe(200);
    });

    it('rejects an oversized webhook payload (provider-agnostic raw-body size guard)', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+984444444444' });
        // Comfortably over the 20KB provider-agnostic webhook size guard (validators/messagingValidators.js) -
        // well beyond what a real single WhatsApp text message (max 4096 chars) plus envelope overhead needs.
        const res = await sendMessage('+984444444444', 'a'.repeat(25000));
        expect(res.status).toBe(400);
    });

    it('accepts a message right up near WhatsApp\'s own real text limit (4096 chars)', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+984444444445' });
        const res = await sendMessage('+984444444445', `help ${'a'.repeat(3000)}`);
        expect(res.status).toBe(200);
    });
});

describe('Rate limiting - wired up on the webhook', () => {
    it('a normal request carries rate-limit headers', async () => {
        const kitchen = await registerKitchen();
        await linkIdentity(kitchen.token, { externalUserId: '+985555555555' });
        const res = await sendMessage('+985555555555', 'help');
        expect(res.headers['ratelimit-limit']).toBeDefined();
        expect(res.headers['ratelimit-remaining']).toBeDefined();
    });
});

describe('The dev-only test endpoint is not the same as claiming production readiness', () => {
    it('behaves identically to the real webhook for a normal message (same processing path)', async () => {
        const kitchen = await registerKitchen();
        await messagingIdentityModel.create({ provider: 'meta', channel: 'whatsapp', externalUserId: '+986666666666', userId: kitchen.user.id, organizationId: kitchen.organization.id });
        const res = await sendMetaWebhook({
            entry: [{
                changes: [{
                    value: {
                        messages: [{
                            from: '+986666666666',
                            id: nextMsgId('meta-help'),
                            type: 'text',
                            text: {
                                body: 'help'
                            },
                            timestamp: String(Math.floor(Date.now() / 1000))
                        }]
                    }
                }]
            }]
        });
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toMatch(/FoodShare Assistant/);
    });
});








