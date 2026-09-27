const crypto = require('crypto');

function freshMetaProvider(envOverrides) {
    const saved = { ...process.env };
    Object.assign(process.env, envOverrides);
    let provider;
    jest.isolateModules(() => {
        provider = require('../src/integrations/messaging/metaProvider');
    });
    process.env = saved;
    return provider;
}

const BASE_ENV = {
    META_WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    META_WHATSAPP_APP_SECRET: 'test-app-secret',
    META_WHATSAPP_ACCESS_TOKEN: 'test-access-token',
    META_WHATSAPP_PHONE_NUMBER_ID: '123456789',
};

function sign(body, secret) {
    return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('metaProvider - registration and contract', () => {
    it('identifies itself and implements the full provider contract', () => {
        const provider = freshMetaProvider(BASE_ENV);
        expect(provider.name).toBe('meta');
        expect(typeof provider.verifyWebhookChallenge).toBe('function');
        expect(typeof provider.verifyWebhook).toBe('function');
        expect(typeof provider.normalizeInbound).toBe('function');
        expect(typeof provider.sendMessage).toBe('function');
    });

    it('is registered under "meta" in the provider registry', () => {
        const { getProvider } = require('../src/integrations/messaging/provider');
        expect(getProvider('meta').name).toBe('meta');
    });
});

describe('metaProvider.verifyWebhookChallenge - GET subscription verification', () => {
    it('succeeds with the correct mode, token and echoes the challenge', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const result = provider.verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '12345' });
        expect(result.ok).toBe(true);
        expect(result.challenge).toBe('12345');
    });

    it('rejects an incorrect verify token', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const result = provider.verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': '12345' });
        expect(result.ok).toBe(false);
        expect(result.challenge).toBeNull();
    });

    it('rejects an incorrect hub.mode', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const result = provider.verifyWebhookChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '12345' });
        expect(result.ok).toBe(false);
    });

    it('rejects a request missing required query parameters', () => {
        const provider = freshMetaProvider(BASE_ENV);
        expect(provider.verifyWebhookChallenge({}).ok).toBe(false);
        expect(provider.verifyWebhookChallenge({ 'hub.mode': 'subscribe' }).ok).toBe(false);
    });

    it('never verifies when no server-side token is configured, even if a token happens to be supplied', () => {
        const provider = freshMetaProvider({ ...BASE_ENV, META_WHATSAPP_VERIFY_TOKEN: '' });
        const result = provider.verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' });
        expect(result.ok).toBe(false);
    });
});

describe('metaProvider.verifyWebhook - POST signature validation', () => {
    it('accepts a correctly signed raw body', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
        const req = { headers: { 'x-hub-signature-256': sign(raw, 'test-app-secret') }, rawBody: raw };
        expect(provider.verifyWebhook(req)).toBe(true);
    });

    it('rejects an invalid/incorrect signature', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
        const req = { headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, rawBody: raw };
        expect(provider.verifyWebhook(req)).toBe(false);
    });

    it('rejects when the body was modified after signing', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const original = Buffer.from(JSON.stringify({ hello: 'world' }));
        const signature = sign(original, 'test-app-secret');
        const tampered = Buffer.from(JSON.stringify({ hello: 'world', extra: 'injected' }));
        const req = { headers: { 'x-hub-signature-256': signature }, rawBody: tampered };
        expect(provider.verifyWebhook(req)).toBe(false);
    });

    it('rejects a missing signature header entirely, safely (no throw)', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const req = { headers: {}, rawBody: Buffer.from('{}') };
        expect(() => provider.verifyWebhook(req)).not.toThrow();
        expect(provider.verifyWebhook(req)).toBe(false);
    });

    it('rejects a malformed signature header (no "sha256=" prefix)', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const raw = Buffer.from('{}');
        const req = { headers: { 'x-hub-signature-256': crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex') }, rawBody: raw };
        expect(provider.verifyWebhook(req)).toBe(false);
    });

    it('fails closed when no raw body was captured', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const req = { headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) }, rawBody: undefined };
        expect(provider.verifyWebhook(req)).toBe(false);
    });

    it('fails closed when no app secret is configured', () => {
        const provider = freshMetaProvider({ ...BASE_ENV, META_WHATSAPP_APP_SECRET: '' });
        const raw = Buffer.from('{}');
        const req = { headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) }, rawBody: raw };
        expect(provider.verifyWebhook(req)).toBe(false);
    });
});

describe('metaProvider.normalizeInbound - real Meta payload shapes', () => {
    function textPayload(text, overrides = {}) {
        return {
            object: 'whatsapp_business_account',
            entry: [
                {
                    id: '102290129340398',
                    changes: [
                        {
                            value: {
                                messaging_product: 'whatsapp',
                                metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
                                contacts: [{ profile: { name: 'Test User' }, wa_id: '16505551234' }],
                                messages: [{ from: '16505551234', id: 'wamid.TEST123', timestamp: '1749416383', type: 'text', text: { body: text }, ...overrides }],
                            },
                            field: 'messages',
                        },
                    ],
                },
            ],
        };
    }

    it('normalizes a real text-message payload into the shared envelope', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const result = provider.normalizeInbound(textPayload('We have 20 boxes of rice meals left, good for 3 hours'));
        expect(result).toEqual({
            provider: 'meta',
            channel: 'whatsapp',
            sender: { externalId: '16505551234' },
            message: { id: 'wamid.TEST123', text: 'We have 20 boxes of rice meals left, good for 3 hours' },
            timestamp: '2025-06-08T20:59:43.000Z',
        });
    });

    it('returns null for a non-message webhook event (e.g. a delivery-status callback)', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const statusPayload = {
            entry: [{ id: '1', changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] }, field: 'messages' }] }],
        };
        expect(provider.normalizeInbound(statusPayload)).toBeNull();
    });

    it('returns null for a malformed/empty payload rather than throwing', () => {
        const provider = freshMetaProvider(BASE_ENV);
        expect(() => provider.normalizeInbound({})).not.toThrow();
        expect(provider.normalizeInbound({})).toBeNull();
        expect(provider.normalizeInbound({ entry: [] })).toBeNull();
    });

    it('normalizes an unsupported message type (e.g. image) with text: null, never guessing content', () => {
        const provider = freshMetaProvider(BASE_ENV);
        const imagePayload = {
            entry: [
                {
                    changes: [
                        {
                            value: {
                                messages: [{ from: '16505551234', id: 'wamid.IMG1', timestamp: '1749416383', type: 'image', image: { id: 'media123' } }],
                            },
                        },
                    ],
                },
            ],
        };
        const result = provider.normalizeInbound(imagePayload);
        expect(result.message.text).toBeNull();
        expect(result.message.id).toBe('wamid.IMG1');
        expect(result.sender.externalId).toBe('16505551234');
    });

    it.each(['audio', 'sticker', 'location', 'video', 'document', 'contacts', 'interactive', 'button', 'reaction'])(
        'never crashes and never guesses text for an unsupported "%s" message type',
        (type) => {
            const provider = freshMetaProvider(BASE_ENV);
            const payload = { entry: [{ changes: [{ value: { messages: [{ from: '1', id: 'wamid.X', timestamp: '1', type }] } }] }] };
            expect(() => provider.normalizeInbound(payload)).not.toThrow();
            expect(provider.normalizeInbound(payload).message.text).toBeNull();
        }
    );
});

describe('metaProvider.sendMessage - real outbound Cloud API call (fetch mocked)', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('sends a real request to the current Graph API version/phone-number-id endpoint with a Bearer token', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.OUT1' }] }),
        });
        const provider = freshMetaProvider(BASE_ENV);
        const result = await provider.sendMessage({ to: '16505551234', channel: 'whatsapp', body: 'hello' });

        expect(result).toEqual({ provider: 'meta', accepted: true, channel: 'whatsapp', recipient: '16505551234', messageId: 'wamid.OUT1' });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/123456789\/messages$/);
        expect(options.headers.Authorization).toBe('Bearer test-access-token');
        expect(JSON.parse(options.body)).toMatchObject({ messaging_product: 'whatsapp', to: '16505551234', type: 'text', text: { body: 'hello' } });
    });

    it('reports a Graph API error response as accepted:false, without leaking the access token', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
        });
        const provider = freshMetaProvider(BASE_ENV);
        const result = await provider.sendMessage({ to: '16505551234', channel: 'whatsapp', body: 'hello' });
        expect(result.accepted).toBe(false);
        expect(result.error).toBe('Invalid OAuth access token');
        expect(JSON.stringify(result)).not.toMatch(/test-access-token/);
    });

    it('handles a network failure/timeout without throwing', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network timeout'));
        const provider = freshMetaProvider(BASE_ENV);
        let result;
        await expect(
            (async () => {
                result = await provider.sendMessage({ to: '16505551234', channel: 'whatsapp', body: 'hello' });
            })()
        ).resolves.not.toThrow();
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/Failed to reach/i);
    });

    it('refuses to send when not configured, without ever attempting a network call', async () => {
        global.fetch = jest.fn();
        const provider = freshMetaProvider({ ...BASE_ENV, META_WHATSAPP_ACCESS_TOKEN: '' });
        const result = await provider.sendMessage({ to: '16505551234', channel: 'whatsapp', body: 'hello' });
        expect(result.accepted).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses to send on an unsupported channel (e.g. sms)', async () => {
        const provider = freshMetaProvider(BASE_ENV);
        const result = await provider.sendMessage({ to: '16505551234', channel: 'sms', body: 'hello' });
        expect(result.accepted).toBe(false);
    });

    it('rejects a missing recipient or empty body without a network call', async () => {
        global.fetch = jest.fn();
        const provider = freshMetaProvider(BASE_ENV);
        expect((await provider.sendMessage({ to: '', channel: 'whatsapp', body: 'hi' })).accepted).toBe(false);
        expect((await provider.sendMessage({ to: '123', channel: 'whatsapp', body: '' })).accepted).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
