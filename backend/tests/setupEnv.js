const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
// Tests never rely on a shared production secret; generate one if none is configured.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-in-production';
process.env.BCRYPT_SALT_ROUNDS = process.env.BCRYPT_SALT_ROUNDS || '4'; // faster hashing in tests
// The auth rate limiter (src/middleware/rateLimiter.js) is real middleware on real routes, so the suite exercises
// it - but a single test file can legitimately register/log in far more than a real client would in one sitting.
// Keep it generous here by default; tests/rateLimiting.test.js overrides these for its own small, deterministic
// checks and restores them afterwards.
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = process.env.AUTH_LOGIN_RATE_LIMIT_MAX || '100000';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = process.env.AUTH_REGISTER_RATE_LIMIT_MAX || '100000';
process.env.COMMUNICATION_RATE_LIMIT_MAX = process.env.COMMUNICATION_RATE_LIMIT_MAX || '100000';
// Exercise the real (mock) send path by default; individual tests that need the disabled path override this
// via jest.isolateModules so config/env.js is re-read with a different value (see demoProductionGuard.test.js
// for the same pattern). The per-listing notification cooldown is left at its normal default - tests that are
// not specifically exercising the cooldown itself simply use a fresh listing each time, so it never interferes.
process.env.COMMUNICATION_ENABLED = process.env.COMMUNICATION_ENABLED || 'true';
// The per-listing notification cooldown (services/rescueNotificationService.js) would otherwise make a second
// notify request in the same test file fail unless a test explicitly wants to exercise it.
process.env.RESCUE_NOTIFICATION_COOLDOWN_MS = process.env.RESCUE_NOTIFICATION_COOLDOWN_MS || '0';
