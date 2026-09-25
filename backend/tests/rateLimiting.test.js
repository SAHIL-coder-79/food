// A small, tight rate limit is configured for THIS FILE ONLY, before anything is required, so the checks below
// are fully deterministic (no waiting on real time, no relying on how many requests other test files happen to
// make). Every other test file keeps the generous default set in tests/setupEnv.js.
const SAVED_ENV = {
    AUTH_LOGIN_RATE_LIMIT_MAX: process.env.AUTH_LOGIN_RATE_LIMIT_MAX,
    AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
    AUTH_REGISTER_RATE_LIMIT_MAX: process.env.AUTH_REGISTER_RATE_LIMIT_MAX,
    AUTH_REGISTER_RATE_LIMIT_WINDOW_MS: process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS,
};
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '3';
process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS = '60000';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '3';
process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS = '60000';

const express = require('express');
const request = require('supertest');
const { app, pool, resetDb, uniqueEmail, registerKitchen } = require('./testHelpers');
const { createRateLimiter, resetAllRateLimiters } = require('../src/middleware/rateLimiter');

// Task 14: authentication rate limiting on the two genuinely anonymous, auth-sensitive endpoints (login,
// registration). Every other route requires a valid bearer token first, so it is not exposed to anonymous
// brute-forcing the same way and is deliberately left unlimited (a per-endpoint limit everywhere would be
// unnecessary and would not address a real threat model there).
//
// All requests in one supertest run share a single loopback address, which is exactly what is needed to test "N
// requests from the same client trip the limit" against the real routes below. Per-key scoping (a different
// client gets its own budget) is a property of the createRateLimiter factory itself, so it is verified directly
// against a throwaway app with an explicit key generator, independent of any real request's source address.

beforeEach(async () => {
    resetAllRateLimiters(); // each test starts with a clean bucket, independent of test order
    await resetDb();
});

afterAll(async () => {
    // Restore whatever the rest of the suite (tests/setupEnv.js) had configured, so no later test file inherits
    // this file's tiny limit.
    Object.entries(SAVED_ENV).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    await pool.end();
});

describe('POST /api/auth/login rate limiting', () => {
    it('allows requests up to the configured limit, then returns 429 with a clear message', async () => {
        const kitchen = await registerKitchen();
        const attempt = () => request(app).post('/api/auth/login').send({ email: kitchen.user.email, password: 'wrong-password' });

        // The limit (3) counts every attempt from this address, successful or not - the first 3 still get a normal
        // 401 for the wrong password.
        for (let i = 0; i < 3; i += 1) {
            const res = await attempt();
            expect(res.status).toBe(401);
        }

        const blocked = await attempt();
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ status: 'error' });
        expect(blocked.body.message).toMatch(/too many/i);
        expect(blocked.headers['retry-after']).toBeDefined();
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('still returns 429 even for an otherwise-valid login once the limit is used up', async () => {
        const kitchen = await registerKitchen();
        for (let i = 0; i < 3; i += 1) {
            await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' });
        }
        const res = await request(app).post('/api/auth/login').send({ email: kitchen.user.email, password: 'password123' });
        expect(res.status).toBe(429);
        expect(res.body.status).toBe('error');
    });

    it('reports the limit and remaining attempts via response headers', async () => {
        const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' });
        expect(res.headers['ratelimit-limit']).toBe('3');
        expect(res.headers['ratelimit-remaining']).toBe('2');
    });

    it('does not rate-limit unrelated authenticated routes', async () => {
        const kitchen = await registerKitchen();
        for (let i = 0; i < 5; i += 1) {
            const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${kitchen.token}`);
            expect(res.status).toBe(200);
        }
    });
});

describe('POST /api/auth/register-organization rate limiting', () => {
    const validPayload = () => ({
        organizationName: 'Rate Limit Test Kitchen', organizationType: 'kitchen', pincode: '1',
        name: 'Owner', email: uniqueEmail('ratelimit'), password: 'password123',
    });

    it('allows registrations up to the configured limit, then returns 429', async () => {
        for (let i = 0; i < 3; i += 1) {
            const res = await request(app).post('/api/auth/register-organization').send(validPayload());
            expect(res.status).toBe(201);
        }
        const blocked = await request(app).post('/api/auth/register-organization').send(validPayload());
        expect(blocked.status).toBe(429);
        expect(blocked.body.message).toMatch(/too many/i);
        expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('validation failures still count towards the limit (a client cannot dodge it with malformed payloads)', async () => {
        for (let i = 0; i < 3; i += 1) {
            const res = await request(app).post('/api/auth/register-organization').send({});
            expect(res.status).toBe(400);
        }
        const blocked = await request(app).post('/api/auth/register-organization').send(validPayload());
        expect(blocked.status).toBe(429);
    });

    it('login and registration are limited independently of each other', async () => {
        for (let i = 0; i < 3; i += 1) {
            expect((await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' })).status).toBe(401);
        }
        expect((await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' })).status).toBe(429);
        // Registration from the exact same address still has its own, unused budget.
        expect((await request(app).post('/api/auth/register-organization').send(validPayload())).status).toBe(201);
    });
});

describe('rate limiting preserves existing authentication behaviour', () => {
    it('bearer-token auth, RBAC and organization isolation are unaffected by rate limiting', async () => {
        const kitchenA = await registerKitchen({ organizationName: 'RL Kitchen A' });
        const kitchenB = await registerKitchen({ organizationName: 'RL Kitchen B' });
        const item = (await request(app).post('/api/menu-items').set('Authorization', `Bearer ${kitchenA.token}`).send({ name: 'x', unit: 'kg' })).body.menuItem;

        expect((await request(app).get('/api/menu-items')).status).toBe(401); // still requires a token
        expect((await request(app).get(`/api/menu-items/${item.id}`).set('Authorization', `Bearer ${kitchenB.token}`)).status).toBe(403); // still org-isolated
        expect((await request(app).get(`/api/menu-items/${item.id}`).set('Authorization', `Bearer ${kitchenA.token}`)).status).toBe(200);
    });
});

// The general mechanism (createRateLimiter), tested in isolation on a throwaway app with an explicit key
// generator - independent of any real route's request source, and of any header the real app does or doesn't
// trust for identifying a client.
describe('createRateLimiter (the underlying mechanism)', () => {
    function buildTestApp(options) {
        const limiter = createRateLimiter({ keyGenerator: (req) => req.headers['x-test-key'], ...options });
        const testApp = express();
        testApp.get('/probe', limiter, (req, res) => res.status(200).json({ ok: true }));
        return testApp;
    }

    it('gives each key its own independent budget', async () => {
        const testApp = buildTestApp({ windowMs: 60000, max: 2 });
        for (let i = 0; i < 2; i += 1) {
            expect((await request(testApp).get('/probe').set('x-test-key', 'client-a')).status).toBe(200);
            expect((await request(testApp).get('/probe').set('x-test-key', 'client-b')).status).toBe(200);
        }
        expect((await request(testApp).get('/probe').set('x-test-key', 'client-a')).status).toBe(429);
        expect((await request(testApp).get('/probe').set('x-test-key', 'client-b')).status).toBe(429);
        expect((await request(testApp).get('/probe').set('x-test-key', 'client-c')).status).toBe(200); // never seen before
    });

    it('uses a default, generic message when none is configured', async () => {
        const testApp = buildTestApp({ windowMs: 60000, max: 1 });
        await request(testApp).get('/probe').set('x-test-key', 'k');
        const res = await request(testApp).get('/probe').set('x-test-key', 'k');
        expect(res.status).toBe(429);
        expect(res.body.message).toMatch(/too many requests/i);
    });

    it('resetAllRateLimiters clears every limiter created so far, including this one', async () => {
        const testApp = buildTestApp({ windowMs: 60000, max: 1 });
        await request(testApp).get('/probe').set('x-test-key', 'k');
        expect((await request(testApp).get('/probe').set('x-test-key', 'k')).status).toBe(429);
        resetAllRateLimiters();
        expect((await request(testApp).get('/probe').set('x-test-key', 'k')).status).toBe(200);
    });
});
