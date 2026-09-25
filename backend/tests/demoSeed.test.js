const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, pool, resetDb } = require('./testHelpers');
const { seedDemoData, alreadySeeded } = require('../scripts/demo/seedDemo');
const { resetDemoData } = require('../scripts/demo/resetDemo');
const { DEMO_ORG_PREFIX, DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, DEMO_ADMIN_EMAIL } = require('../scripts/demo/constants');

// Task 10: the demo dataset. seedDemoData() itself walks the whole product loop through the real HTTP API and
// throws immediately if any step (forecast, root cause, prevention, spoilage, matching, claim/pickup/collect,
// financial/environmental impact, forecast-vs-actual, learning, event-aware forecasting, ...) doesn't behave as
// the scenario expects — so a successful run below is itself the proof that every one of those still works. These
// tests add what the seed script cannot check about itself: it never runs unless asked, it refuses to double-seed,
// reset only ever touches its own data, and a completely unrelated organization is never affected.

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const login = (email, password = DEMO_PASSWORD) => request(app).post('/api/auth/login').send({ email, password });

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await pool.end();
});

describe('demo data is never seeded automatically', () => {
    it('does not exist after ordinary app usage', async () => {
        await request(app).post('/api/auth/register-organization').send({
            organizationName: 'Ordinary Kitchen', organizationType: 'kitchen', pincode: '1', name: 'Owner', email: 'ordinary@example.com', password: 'password123',
        });
        expect(await alreadySeeded()).toBe(false);
    });

    it('is wired into no startup path (server boot, migrations)', () => {
        const srcDir = path.join(__dirname, '../src');
        const bootFiles = ['index.js', 'app.js'].map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'));
        const migrateSource = fs.readFileSync(path.join(__dirname, '../scripts/migrate.js'), 'utf8');
        [...bootFiles, migrateSource].forEach((source) => {
            expect(source).not.toMatch(/seedDemo|demo\/seed|scripts\/demo/);
        });
    });

    it('is exposed only through explicit npm scripts', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
        expect(pkg.scripts['demo:seed']).toMatch(/seedDemo\.js$/);
        expect(pkg.scripts['demo:reset']).toMatch(/resetDemo\.js$/);
    });
});

describe('seeding the scenario', () => {
    it('completes end to end (every scenario step self-checked internally) and is usable over the real API', async () => {
        const result = await seedDemoData();
        expect(result.kitchenA.organization.name).toBe(`${DEMO_ORG_PREFIX}Anna Sewa Community Kitchen`);
        expect(result.credentials.length).toBeGreaterThanOrEqual(6);

        const managerLogin = await login(`kitchen.manager@${DEMO_EMAIL_DOMAIN}`);
        expect(managerLogin.status).toBe(200);
        const menu = await request(app).get('/api/menu-items').set(auth(managerLogin.body.token));
        expect(menu.body.menuItems.map((m) => m.name).sort()).toEqual(['Chapati', 'Milled Rice Flour', 'Veg Thali']);

        // The pending NGO really cannot use the feed yet - the "verify it live" part of the demo is still real.
        const pendingLogin = await login(`ngo.newhope@${DEMO_EMAIL_DOMAIN}`);
        expect((await request(app).get('/api/surplus-listings/feed').set(auth(pendingLogin.body.token))).status).toBe(403);

        // One listing was left open on purpose, for a live claim during the demo.
        const openListing = (await request(app).get('/api/surplus-listings').set(auth(managerLogin.body.token))).body.listings.find((l) => l.status === 'Available');
        expect(openListing).toBeDefined();

        // Kitchen B is a real, separate tenant - it must see none of Kitchen A's data.
        const kitchenBLogin = await login(`kitchen2.manager@${DEMO_EMAIL_DOMAIN}`);
        const kitchenBMenu = await request(app).get('/api/menu-items').set(auth(kitchenBLogin.body.token));
        expect(kitchenBMenu.body.menuItems.map((m) => m.name)).toEqual(['Sambar Rice']);
    }, 60000);

    it('refuses to run twice without a reset, and creates nothing on the second attempt', async () => {
        await seedDemoData();
        const before = (await pool.query("SELECT id FROM organizations WHERE name LIKE $1 ORDER BY id", [`${DEMO_ORG_PREFIX}%`])).rows;

        await expect(seedDemoData()).rejects.toThrow(/already exists/);

        const after = (await pool.query("SELECT id FROM organizations WHERE name LIKE $1 ORDER BY id", [`${DEMO_ORG_PREFIX}%`])).rows;
        expect(after).toEqual(before);
    }, 60000);
});

describe('resetting the scenario', () => {
    it('is a safe no-op when nothing has been seeded', async () => {
        const summary = await resetDemoData({ log: () => {} });
        expect(summary).toEqual({ organizationsRemoved: 0, usersRemoved: 0 });
    });

    it('removes exactly the demo organizations, users and the demo admin - and nothing else', async () => {
        const decoy = await request(app).post('/api/auth/register-organization').send({
            organizationName: 'Real Unrelated Kitchen', organizationType: 'kitchen', pincode: '1', name: 'Real Owner', email: 'real.owner@example.com', password: 'password123',
        });
        const decoyItem = await request(app).post('/api/menu-items').set(auth(decoy.body.token)).send({ name: 'Real Dish', unit: 'kg' });
        const decoyLog = await request(app).post('/api/daily-logs').set(auth(decoy.body.token)).send({ menuItemId: decoyItem.body.menuItem.id, logDate: '2026-01-05', mealSlot: 'LUNCH', quantityPrepared: 10, quantityLeftover: 2 });

        await seedDemoData();
        const summary = await resetDemoData({ log: () => {} });
        expect(summary.organizationsRemoved).toBe(5); // Kitchen A, Kitchen B, 3 NGOs (the pending one included)
        expect(await alreadySeeded()).toBe(false);

        // The decoy organization is completely untouched.
        expect((await pool.query('SELECT id, name FROM organizations WHERE id = $1', [decoy.body.organization.id])).rows).toEqual([{ id: decoy.body.organization.id, name: 'Real Unrelated Kitchen' }]);
        expect((await pool.query('SELECT id FROM menu_items WHERE id = $1', [decoyItem.body.menuItem.id])).rows).toHaveLength(1);
        expect((await pool.query('SELECT id FROM daily_logs WHERE id = $1', [decoyLog.body.log.id])).rows).toHaveLength(1);
        expect((await pool.query('SELECT id FROM users WHERE email = $1', ['real.owner@example.com'])).rows).toHaveLength(1);

        // No demo residue anywhere: users, menu items, or the demo system admin.
        expect((await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE email LIKE '%' || $1", [DEMO_EMAIL_DOMAIN])).rows[0].n).toBe(0);
        expect((await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_ADMIN_EMAIL])).rows).toHaveLength(0);
        expect((await pool.query("SELECT COUNT(*)::int AS n FROM menu_items WHERE name IN ('Veg Thali', 'Chapati', 'Milled Rice Flour', 'Sambar Rice')")).rows[0].n).toBe(0);

        // Every table the seed touches is clean of demo rows (nothing orphaned by a deletion-order mistake).
        for (const table of ['daily_logs', 'surplus_listings', 'transactions_log', 'ai_forecasts', 'ai_waste_root_causes', 'ai_prevention_recommendations', 'ai_rescue_priorities', 'ai_ngo_match_scores', 'ai_financial_impacts', 'ai_interventions', 'organization_events', 'notifications']) {
            const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
            // The decoy organization contributed exactly one daily_logs row and nothing to any other table.
            expect(rows[0].n).toBe(table === 'daily_logs' ? 1 : 0);
        }
    }, 60000);

    it('lets the scenario be seeded again cleanly after a reset', async () => {
        await seedDemoData();
        await resetDemoData({ log: () => {} });
        await expect(seedDemoData()).resolves.toBeDefined();
        expect(await alreadySeeded()).toBe(true);
    }, 90000);
});
