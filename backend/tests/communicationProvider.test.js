const mockProvider = require('../src/integrations/communication/mockProvider');
const { getProvider, PROVIDERS } = require('../src/integrations/communication/provider');

function freshRequire(id) {
    let mod;
    jest.isolateModules(() => {
        mod = require(id);
    });
    return mod;
}

describe('communication provider registry', () => {
    it('resolves the mock provider by name', () => {
        expect(getProvider('mock')).toBe(mockProvider);
        expect(PROVIDERS.mock).toBe(mockProvider);
    });

    it('throws a clear error for an unknown provider name', () => {
        expect(() => getProvider('some-real-whatsapp-provider')).toThrow(/Unknown communication provider/);
    });

    it('the mock provider identifies itself', () => {
        expect(mockProvider.name).toBe('mock');
    });
});

describe('mockProvider.sendMessage - deterministic behaviour, never a real send', () => {
    it('accepts a well-formed message and returns a deterministic message id', () => {
        const first = mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'Rescue opportunity #1' });
        const second = mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'Rescue opportunity #1' });
        expect(first.accepted).toBe(true);
        expect(first.provider).toBe('mock');
        expect(first.channel).toBe('whatsapp');
        expect(typeof first.messageId).toBe('string');
        expect(first.messageId).toBe(second.messageId); // same input -> same id, every time
    });

    it('a different body produces a different message id', () => {
        const a = mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'Message A' });
        const b = mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'Message B' });
        expect(a.messageId).not.toBe(b.messageId);
    });

    it('supports both whatsapp and sms channels', () => {
        expect(mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'hi' }).accepted).toBe(true);
        expect(mockProvider.sendMessage({ to: '+911234567890', channel: 'sms', body: 'hi' }).accepted).toBe(true);
    });

    it('rejects an unsupported channel, e.g. email or a typo', () => {
        const result = mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'email', body: 'hi' });
        expect(result.accepted).toBe(false);
        expect(result.provider).toBe('mock');
        expect(result.error).toMatch(/unsupported channel/i);
    });

    it('rejects a missing/malformed recipient', () => {
        expect(mockProvider.sendMessage({ to: '', channel: 'whatsapp', body: 'hi' }).accepted).toBe(false);
        expect(mockProvider.sendMessage({ to: undefined, channel: 'whatsapp', body: 'hi' }).accepted).toBe(false);
        expect(mockProvider.sendMessage({ to: 42, channel: 'whatsapp', body: 'hi' }).accepted).toBe(false);
    });

    it('rejects an empty message body', () => {
        const result = mockProvider.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: '' });
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/body is required/i);
    });

    it('never mutates its input and never throws for well-formed input', () => {
        const message = { to: 'ngo@example.com', channel: 'sms', body: 'test' };
        const snapshot = { ...message };
        expect(() => mockProvider.sendMessage(message)).not.toThrow();
        expect(message).toEqual(snapshot);
    });
});

describe('integrations/communication/service - the enable/disable switch', () => {
    function serviceWithEnv(overrides) {
        const saved = { ...process.env };
        Object.assign(process.env, overrides);
        const svc = freshRequire('../src/integrations/communication/service');
        Object.assign(process.env, saved);
        return svc;
    }

    it('is a safe no-op when communication is disabled, and says so explicitly', () => {
        const service = serviceWithEnv({ COMMUNICATION_ENABLED: 'false' });
        const result = service.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'hi' });
        expect(result.accepted).toBe(false);
        expect(result.disabled).toBe(true);
        expect(result.provider).toBeNull();
    });

    it('delegates to the configured provider when enabled', () => {
        const service = serviceWithEnv({ COMMUNICATION_ENABLED: 'true', COMMUNICATION_PROVIDER: 'mock' });
        const result = service.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'hi' });
        expect(result.disabled).toBe(false);
        expect(result.accepted).toBe(true);
        expect(result.provider).toBe('mock');
    });

    it('reports a provider failure as a failed result, never throwing', () => {
        const service = serviceWithEnv({ COMMUNICATION_ENABLED: 'true', COMMUNICATION_PROVIDER: 'not-a-real-provider' });
        let result;
        expect(() => {
            result = service.sendMessage({ to: 'ngo@example.com', channel: 'whatsapp', body: 'hi' });
        }).not.toThrow();
        expect(result.accepted).toBe(false);
        expect(result.disabled).toBe(false);
        expect(result.error).toMatch(/Unknown communication provider/);
    });
});
