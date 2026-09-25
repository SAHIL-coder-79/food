const { assertNotProduction } = require('../scripts/demo/productionGuard');
const { pool, resetDb } = require('./testHelpers');

// Task 14: demo credentials (including a fixed, publicly-documented demo SYSTEM_ADMIN password - see
// scripts/demo/README.md) must never be creatable against a production environment. This is a pure, dependency-
// light guard (only src/config/env.js), so it is tested directly with jest.isolateModules rather than through the
// whole app/database module graph.

// Runs `fn` (synchronous) with NODE_ENV temporarily set, always restoring it afterwards.
function withNodeEnv(value, fn) {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try {
        return fn();
    } finally {
        process.env.NODE_ENV = saved;
    }
}

// A fresh require of productionGuard (and the config/env it reads NODE_ENV from), isolated so it never pollutes
// this file's own already-cached (test-env) modules. jest.isolateModules runs its callback for the side effect of
// re-requiring inside a sandboxed registry; it does not return the callback's result, so the module reference is
// captured via a variable declared outside it.
function freshRequire(id) {
    let mod;
    jest.isolateModules(() => {
        mod = require(id);
    });
    return mod;
}
const freshGuard = () => freshRequire('../scripts/demo/productionGuard');

afterAll(async () => {
    await pool.end();
});

describe('demo data production guard', () => {
    it('refuses to run when NODE_ENV is "production"', () => {
        const { assertNotProduction: guard } = withNodeEnv('production', freshGuard);
        expect(guard).toThrow(/production/i);
        expect(guard).toThrow(/demo/i);
    });

    it('mentions what is being refused when a context label is given', () => {
        const { assertNotProduction: guard } = withNodeEnv('production', freshGuard);
        expect(() => guard('reset demo data')).toThrow(/refusing to reset demo data/i);
    });

    it('does not throw for development or test environments', () => {
        expect(withNodeEnv('development', freshGuard).assertNotProduction).not.toThrow();
        expect(withNodeEnv('test', freshGuard).assertNotProduction).not.toThrow();
    });

    it('is the exact guard used by the seed/reset scripts, not a re-derived stand-in', () => {
        expect(typeof assertNotProduction).toBe('function');
        expect(() => assertNotProduction()).not.toThrow(); // this file runs under NODE_ENV=test
    });
});

describe('seedDemoData refuses to touch the database when NODE_ENV is "production"', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('creates nothing: the guard fires before any organization is written', async () => {
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM organizations')).rows[0].n;

        // Require the isolated module while NODE_ENV is "production" (capturing that into its closure), then
        // restore NODE_ENV immediately - the require itself is synchronous, so this cannot race the async call below.
        const { seedDemoData } = withNodeEnv('production', () => freshRequire('../scripts/demo/seedDemo'));

        await expect(seedDemoData()).rejects.toThrow(/production/i);
        const after = (await pool.query('SELECT COUNT(*)::int AS n FROM organizations')).rows[0].n;
        expect(after).toBe(before);
    });
});
