// config/env.js's own startup validation only runs outside NODE_ENV=test (see validateEnv()'s early return),
// so exercising it requires temporarily pretending to be a non-test environment inside an isolated module
// load - the same technique already used by demoProductionGuard.test.js and communicationProvider.test.js.
function freshEnvWith(overrides) {
    const saved = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'development' }, overrides);
    let result = null;
    let thrown = null;
    jest.isolateModules(() => {
        try {
            result = require('../src/config/env');
        } catch (error) {
            thrown = error;
        }
    });
    process.env = saved;
    return { result, thrown };
}

describe('config/env.js - Meta configuration fails fast rather than silently falling back to mock', () => {
    it('throws at startup when MESSAGING_PROVIDER=meta is requested with no Meta configuration at all', () => {
        const { thrown } = freshEnvWith({
            MESSAGING_ENABLED: 'true',
            MESSAGING_PROVIDER: 'meta',
            META_WHATSAPP_VERIFY_TOKEN: '',
            META_WHATSAPP_APP_SECRET: '',
            META_WHATSAPP_ACCESS_TOKEN: '',
            META_WHATSAPP_PHONE_NUMBER_ID: '',
        });
        expect(thrown).not.toBeNull();
        expect(thrown.message).toMatch(/MESSAGING_PROVIDER=meta requires/);
    });

    it('names each specific missing variable, not just a generic failure', () => {
        const { thrown } = freshEnvWith({
            MESSAGING_ENABLED: 'true',
            MESSAGING_PROVIDER: 'meta',
            META_WHATSAPP_VERIFY_TOKEN: 'present',
            META_WHATSAPP_APP_SECRET: '',
            META_WHATSAPP_ACCESS_TOKEN: '',
            META_WHATSAPP_PHONE_NUMBER_ID: 'present',
        });
        expect(thrown.message).toMatch(/META_WHATSAPP_APP_SECRET/);
        expect(thrown.message).toMatch(/META_WHATSAPP_ACCESS_TOKEN/);
        expect(thrown.message).not.toMatch(/META_WHATSAPP_VERIFY_TOKEN,|META_WHATSAPP_VERIFY_TOKEN$/);
    });

    it('does not throw when messaging is disabled, even with MESSAGING_PROVIDER=meta and no config', () => {
        const { thrown } = freshEnvWith({ MESSAGING_ENABLED: 'false', MESSAGING_PROVIDER: 'meta' });
        expect(thrown).toBeNull();
    });

    it('does not throw when MESSAGING_PROVIDER=meta and every required variable is present', () => {
        const { thrown, result } = freshEnvWith({
            MESSAGING_ENABLED: 'true',
            MESSAGING_PROVIDER: 'meta',
            META_WHATSAPP_VERIFY_TOKEN: 't',
            META_WHATSAPP_APP_SECRET: 's',
            META_WHATSAPP_ACCESS_TOKEN: 'a',
            META_WHATSAPP_PHONE_NUMBER_ID: 'p',
        });
        expect(thrown).toBeNull();
        // Never silently downgraded to mock - the configured provider is exactly what was asked for.
        expect(result.messagingProvider).toBe('meta');
    });

    it('does not require any Meta configuration for the default mock provider', () => {
        const { thrown } = freshEnvWith({ MESSAGING_ENABLED: 'true', MESSAGING_PROVIDER: 'mock' });
        expect(thrown).toBeNull();
    });
});
