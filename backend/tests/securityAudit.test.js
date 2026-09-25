const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, pool, resetDb, uniqueEmail, registerKitchen, registerNgo, createSystemAdmin, verifyNgo } = require('./testHelpers');

// Security audit (Task 7). Every authenticated API route is classified below; the matrix tests then assert, against a
// real database and real JWTs, that each route rejects missing/invalid tokens and deactivated users, enforces its
// role list, and never lets one organization touch another's data.

const A = (token) => ({ Authorization: `Bearer ${token}` });
const future = (hours = 5) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

const KM = 'KITCHEN_MANAGER';
const KS = 'KITCHEN_STAFF';
const NA = 'NGO_ADMIN';
const NC = 'NGO_COORDINATOR';
const SA = 'SYSTEM_ADMIN';
const ALL_ROLES = [KM, KS, NA, NC, SA];
const KITCHEN = [KM, KS];
const NGO = [NA, NC];

// [route file, method, path inside the file, allowed roles, options]. `public` = intentionally unauthenticated.
// `ownership` = every role passes the role check but access is decided by ownership of the resource.
// `needsOrg` = allowed roles that have no organization (system admin) are refused for lack of one, not by role.
const ROUTES = [
    ['health', 'get', '/health', null, { public: true }],
    ['authRoutes', 'post', '/register-organization', null, { public: true }],
    ['authRoutes', 'post', '/login', null, { public: true }],
    ['authRoutes', 'post', '/users', [KM, NA, SA], {}],
    ['authRoutes', 'get', '/me', ALL_ROLES, {}],
    ['organizationRoutes', 'get', '/me', ALL_ROLES, { needsOrg: [SA] }],
    ['organizationRoutes', 'patch', '/me', [KM, NA], {}],
    ['organizationRoutes', 'get', '/pending-ngos', [SA], {}],
    ['organizationRoutes', 'get', '/', ALL_ROLES, {}],
    ['organizationRoutes', 'get', '/:id', ALL_ROLES, { ownership: true }],
    ['organizationRoutes', 'patch', '/:id/verify', [SA], {}],
    ['menuItemRoutes', 'post', '/', KITCHEN, {}],
    ['menuItemRoutes', 'get', '/', KITCHEN, {}],
    ['menuItemRoutes', 'get', '/:id', KITCHEN, {}],
    ['menuItemRoutes', 'patch', '/:id', KITCHEN, {}],
    ['menuItemRoutes', 'delete', '/:id', [KM], {}],
    ['dailyLogRoutes', 'post', '/', KITCHEN, {}],
    ['dailyLogRoutes', 'get', '/', KITCHEN, {}],
    ['dailyLogRoutes', 'get', '/:id', KITCHEN, {}],
    ['dailyLogRoutes', 'patch', '/:id', KITCHEN, {}],
    ['dailyLogRoutes', 'delete', '/:id', KITCHEN, {}],
    ['surplusListingRoutes', 'post', '/', KITCHEN, {}],
    ['surplusListingRoutes', 'post', '/spoilage-estimate', KITCHEN, {}],
    ['surplusListingRoutes', 'get', '/', KITCHEN, {}],
    ['surplusListingRoutes', 'get', '/feed', NGO, {}],
    ['surplusListingRoutes', 'get', '/:id', [...KITCHEN, ...NGO], {}],
    ['surplusListingRoutes', 'get', '/:id/spoilage-assessment', [...KITCHEN, ...NGO], {}],
    ['surplusListingRoutes', 'post', '/:id/claim', NGO, {}],
    ['surplusListingRoutes', 'patch', '/:id/confirm-pickup', KITCHEN, {}],
    ['surplusListingRoutes', 'patch', '/:id/collect', [...KITCHEN, ...NGO], {}],
    ['surplusListingRoutes', 'get', '/:id/ngo-matches', [...KITCHEN, SA], {}],
    ['notificationRoutes', 'get', '/', ALL_ROLES, {}],
    ['notificationRoutes', 'patch', '/read-all', ALL_ROLES, {}],
    ['notificationRoutes', 'patch', '/:id/read', ALL_ROLES, {}],
    ['analyticsRoutes', 'get', '/waste-attribution', KITCHEN, {}],
    ['analyticsRoutes', 'get', '/forecast-performance', KITCHEN, {}],
    ['eventRoutes', 'get', '/', KITCHEN, {}],
    ['eventRoutes', 'post', '/', [KM], {}],
    ['eventRoutes', 'delete', '/:id', [KM], {}],
    ['forecasts', 'get', '/:menuItemId', [...KITCHEN, SA], {}],
    ['financialImpactRoutes', 'get', '/', [...KITCHEN, SA], {}],
    ['simulationRoutes', 'post', '/run', [...KITCHEN, SA], {}],
    ['learningRoutes', 'post', '/evaluate', [...KITCHEN, SA], {}],
    ['processingRoutes', 'get', '/products', [...KITCHEN, SA], {}],
    ['processingRoutes', 'post', '/products', [KM, SA], { needsOrg: [SA] }],
    ['processingRoutes', 'get', '/batches', [...KITCHEN, SA], {}],
    ['processingRoutes', 'post', '/batches', [...KITCHEN, SA], { needsOrg: [SA] }],
    ['rootCauses', 'get', '/:dailyLogId', [...KITCHEN, SA], {}],
    ['prevention', 'post', '/evaluate', KITCHEN, {}],
    ['prevention', 'patch', '/:id/status', [KM], {}],
    ['rescuePriorities', 'get', '/', [...NGO, SA], {}],
    ['foodQualityRoutes', 'post', '/check', KITCHEN, {}],
    ['donationLedgerRoutes', 'get', '/:listingId/ledger', [...KITCHEN, ...NGO], {}],
    ['donationLedgerRoutes', 'get', '/:listingId/ledger/verify', [...KITCHEN, ...NGO], {}],
    ['donationLedgerRoutes', 'get', '/:listingId/certificate', [...KITCHEN, ...NGO], {}],
    ['rescueRouteRoutes', 'post', '/preview', NGO, {}],
    ['rescueNotificationRoutes', 'post', '/rescue/:listingId/notify', KITCHEN, {}],
];

const BASE = {
    health: '/api',
    authRoutes: '/api/auth',
    organizationRoutes: '/api/organizations',
    menuItemRoutes: '/api/menu-items',
    dailyLogRoutes: '/api/daily-logs',
    surplusListingRoutes: '/api/surplus-listings',
    notificationRoutes: '/api/notifications',
    analyticsRoutes: '/api/analytics',
    eventRoutes: '/api/events',
    forecasts: '/api/forecasts',
    financialImpactRoutes: '/api/financial-impact',
    simulationRoutes: '/api/simulations',
    learningRoutes: '/api/learning',
    processingRoutes: '/api/processing',
    rootCauses: '/api/root-causes',
    prevention: '/api/prevention',
    rescuePriorities: '/api/rescue-priorities',
    foodQualityRoutes: '/api/food-quality',
    donationLedgerRoutes: '/api/donations',
    rescueRouteRoutes: '/api/rescue-routes',
    rescueNotificationRoutes: '/api/communications',
};

const NONEXISTENT_ID = '2000000000'; // valid integer, no such row: role checks run before any ownership lookup
const urlOf = ([file, , routePath]) => {
    const full = `${BASE[file]}${routePath === '/' ? '' : routePath}`;
    return full.replace(/:\w+/g, NONEXISTENT_ID);
};
const send = (route, token) => {
    const [, method] = route;
    let req = request(app)[method](urlOf(route));
    if (token) req = req.set(A(token));
    return method === 'get' || method === 'delete' ? req : req.send({});
};

const users = {};
let k1;
let k2;
let ngo1;
let ngo2;
let admin;
let staff1;
let inactiveToken;

async function createSubUser(actingToken, role) {
    const res = await request(app).post('/api/auth/users').set(A(actingToken)).send({ name: 'Sub', email: uniqueEmail('sub'), password: 'password123', role });
    expect(res.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: res.body.user.email, password: 'password123' });
    return { user: res.body.user, token: login.body.token };
}

beforeAll(async () => {
    await resetDb();
    k1 = await registerKitchen({ organizationName: 'Kitchen One' });
    k2 = await registerKitchen({ organizationName: 'Kitchen Two' });
    ngo1 = await registerNgo({ organizationName: 'NGO One' });
    ngo2 = await registerNgo({ organizationName: 'NGO Two' });
    admin = await createSystemAdmin();
    await verifyNgo(ngo1.organization.id, admin.token);
    await verifyNgo(ngo2.organization.id, admin.token);
    staff1 = await createSubUser(k1.token, KS);
    const coordinator = await createSubUser(ngo1.token, NC);
    users[KM] = k1.token;
    users[KS] = staff1.token;
    users[NA] = ngo1.token;
    users[NC] = coordinator.token;
    users[SA] = admin.token;

    const doomed = await createSubUser(k1.token, KM);
    inactiveToken = doomed.token;
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [doomed.user.id]);
}, 120000);

afterAll(async () => {
    await pool.end();
});

// ---------------------------------------------------------------------------
// 1. Inventory: no route can be added or changed without being classified here
// ---------------------------------------------------------------------------

describe('route inventory', () => {
    const routesDir = path.join(__dirname, '../src/routes');
    const declared = [];
    fs.readdirSync(routesDir)
        .filter((f) => f.endsWith('.js') && f !== 'index.js')
        .forEach((f) => {
            const text = fs.readFileSync(path.join(routesDir, f), 'utf8');
            for (const m of text.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
                declared.push(`${f.replace('.js', '')} ${m[1]} ${m[2]}`);
            }
        });
    const classified = ROUTES.map(([file, method, routePath]) => `${file} ${method} ${routePath}`);

    it('classifies every route declared in src/routes (and nothing that does not exist)', () => {
        expect(declared.sort()).toEqual(classified.sort());
        expect(declared.length).toBe(57);
    });

    it('mounts every route file under a known prefix', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8') + fs.readFileSync(path.join(routesDir, 'index.js'), 'utf8');
        Object.entries(BASE).forEach(([file, base]) => {
            if (file === 'health') return;
            expect(appSource).toContain(base.replace('/api', '') || '/');
        });
    });

    it('attaches authenticate to every route file that has protected routes', () => {
        ROUTES.filter((r) => !r[4].public).forEach(([file]) => {
            const text = fs.readFileSync(path.join(routesDir, `${file}.js`), 'utf8');
            expect(text).toMatch(/authenticate/);
        });
    });
});

// ---------------------------------------------------------------------------
// 2. Authentication matrix: JWT required, invalid tokens and inactive users rejected
// ---------------------------------------------------------------------------

describe('authentication on every protected route', () => {
    const protectedRoutes = ROUTES.filter((r) => !r[4].public);

    it.each(protectedRoutes.map((r) => [`${r[1].toUpperCase()} ${BASE[r[0]]}${r[2]}`, r]))('%s requires a token', async (_name, route) => {
        expect((await send(route, null)).status).toBe(401);
    });

    it.each(protectedRoutes.map((r) => [`${r[1].toUpperCase()} ${BASE[r[0]]}${r[2]}`, r]))('%s rejects a garbage token', async (_name, route) => {
        expect((await send(route, 'not-a-real-jwt')).status).toBe(401);
    });

    it.each(protectedRoutes.map((r) => [`${r[1].toUpperCase()} ${BASE[r[0]]}${r[2]}`, r]))('%s rejects a deactivated user holding a valid token', async (_name, route) => {
        expect((await send(route, inactiveToken)).status).toBe(401);
    });

    it('the public routes are exactly health, register-organization and login', () => {
        expect(ROUTES.filter((r) => r[4].public).map((r) => r[2]).sort()).toEqual(['/health', '/login', '/register-organization']);
    });
});

// ---------------------------------------------------------------------------
// 3. Role matrix
// ---------------------------------------------------------------------------

describe('role authorization on every protected route', () => {
    const cases = [];
    ROUTES.filter((r) => !r[4].public).forEach((route) => {
        ALL_ROLES.forEach((role) => cases.push([`${route[1].toUpperCase()} ${BASE[route[0]]}${route[2]} as ${role}`, route, role]));
    });

    it.each(cases)('%s', async (_name, route, role) => {
        const [, , , allowed, options] = route;
        const res = await send(route, users[role]);
        if (!allowed.includes(role)) {
            expect(res.status).toBe(403);
            return;
        }
        expect(res.status).not.toBe(401);
        const ownershipDecides = options.ownership || (options.needsOrg || []).includes(role);
        if (!ownershipDecides) expect(res.status).not.toBe(403);
        expect(res.status).toBeLessThan(500);
    });
});

// ---------------------------------------------------------------------------
// 4. JWT hardening
// ---------------------------------------------------------------------------

describe('JWT handling', () => {
    const me = (token) => request(app).get('/api/auth/me').set(A(token));
    const secret = () => process.env.JWT_SECRET;

    it('rejects an unsigned (alg none) token', async () => {
        const token = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: k1.user.id })).toString('base64url')}.`;
        expect((await me(token)).status).toBe(401);
    });

    it('rejects a token signed with another secret, and an expired one', async () => {
        expect((await me(jwt.sign({ sub: k1.user.id }, 'some-other-secret'))).status).toBe(401);
        expect((await me(jwt.sign({ sub: k1.user.id }, secret(), { expiresIn: -10 }))).status).toBe(401);
    });

    it('accepts only the HS256 algorithm the app signs with', async () => {
        expect((await me(jwt.sign({ sub: k1.user.id }, secret(), { algorithm: 'HS256' }))).status).toBe(200);
        expect((await me(jwt.sign({ sub: k1.user.id }, secret(), { algorithm: 'HS512' }))).status).toBe(401);
    });

    it.each([['non-numeric', 'abc'], ['huge', 99999999999], ['zero', 0], ['negative', -3], ['fractional', 1.5], ['missing', undefined], ['an object', { $gt: 0 }]])(
        'answers 401, not 500, for a validly-signed token whose subject is %s',
        async (_name, sub) => {
            const res = await me(jwt.sign(sub === undefined ? {} : { sub }, secret()));
            expect(res.status).toBe(401);
            expect(JSON.stringify(res.body)).not.toMatch(/invalid input|out of range|syntax/i);
        }
    );

    it('takes role and organization from the database, never from token claims', async () => {
        const forged = jwt.sign({ sub: k1.user.id, role: SA, organizationId: k2.organization.id }, secret());
        expect((await request(app).get('/api/organizations/pending-ngos').set(A(forged))).status).toBe(403);
        const items = await request(app).post('/api/menu-items').set(A(forged)).send({ name: 'Forged claim item', unit: 'kg' });
        expect(items.status).toBe(201);
        expect(items.body.menuItem.kitchen_org_id).toBe(k1.organization.id);
    });

    it('rejects a lowercase or missing Bearer scheme', async () => {
        expect((await request(app).get('/api/auth/me').set({ Authorization: `bearer ${k1.token}` })).status).toBe(401);
        expect((await request(app).get('/api/auth/me').set({ Authorization: k1.token })).status).toBe(401);
    });

    it('has no fallback secret: production refuses to start without a strong JWT_SECRET', () => {
        const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
        const load = () => jest.isolateModules(() => require('../src/config/env'));
        try {
            process.env.NODE_ENV = 'production';
            process.env.JWT_SECRET = ''; // (a deleted variable would simply be re-filled from .env by dotenv)
            expect(load).toThrow(/JWT_SECRET/);
            process.env.JWT_SECRET = 'too-short';
            expect(load).toThrow(/at least 32 characters/);
            process.env.JWT_SECRET = 'x'.repeat(48);
            expect(load).not.toThrow();
        } finally {
            process.env.NODE_ENV = saved.NODE_ENV;
            process.env.JWT_SECRET = saved.JWT_SECRET;
        }
    });

    it('contains no mock-auth or header-based identity bypass in production code', () => {
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
        const offenders = walk(path.join(__dirname, '../src'))
            .filter((f) => f.endsWith('.js'))
            .filter((f) => /x-mock|x-user-|x-org-|skipAuth|bypassAuth|MOCK_AUTH|DEV_TOKEN/i.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
        // A request that only sets identity headers is still unauthenticated.
        return request(app).get('/api/menu-items').set({ 'x-mock-role': KM, 'x-mock-org-id': '1', 'x-user-id': '1' }).expect(401);
    });
});

// ---------------------------------------------------------------------------
// 5. Cross-organization attacks: kitchen one against kitchen two's data
// ---------------------------------------------------------------------------

describe('cross-organization access', () => {
    let item2;
    let log2;
    let listing2;
    let recommendation2;
    let notification2;

    beforeAll(async () => {
        item2 = (await request(app).post('/api/menu-items').set(A(k2.token)).send({ name: 'K2 Rice', unit: 'kg', costPerUnit: 10 })).body.menuItem;
        log2 = (await request(app).post('/api/daily-logs').set(A(k2.token)).send({ menuItemId: item2.id, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityPrepared: 50, quantityLeftover: 10, quantityConsumed: 40 })).body.log;
        listing2 = (await request(app).post('/api/surplus-listings').set(A(k2.token)).send({ quantity: 10, foodType: 'Rice', safeUntilTime: future(6) })).body.listing;
        recommendation2 = (await request(app).post('/api/prevention/evaluate').set(A(k2.token)).send({ menuItemId: item2.id, targetDate: '2026-03-05', plannedQuantity: 500 })).body.data;
        await request(app).post(`/api/surplus-listings/${listing2.id}/claim`).set(A(ngo1.token)).send({ proposedPickupTime: future(2) });
        notification2 = (await pool.query("SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.organization_id = $1 AND n.type = 'LISTING_CLAIMED' LIMIT 1", [k2.organization.id])).rows[0];
    });

    const row = async (sql, params) => (await pool.query(sql, params)).rows[0];

    it('kitchen one cannot read, change or delete kitchen two\'s menu item', async () => {
        expect((await request(app).get(`/api/menu-items/${item2.id}`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).patch(`/api/menu-items/${item2.id}`).set(A(k1.token)).send({ name: 'hijacked', costPerUnit: 0 })).status).toBe(403);
        expect((await request(app).delete(`/api/menu-items/${item2.id}`).set(A(k1.token))).status).toBe(403);
        expect(await row('SELECT name, cost_per_unit, is_active FROM menu_items WHERE id = $1', [item2.id])).toEqual({ name: 'K2 Rice', cost_per_unit: 10, is_active: true });
    });

    it('does not list another organization\'s menu items, logs, listings or notifications', async () => {
        expect((await request(app).get('/api/menu-items?includeInactive=true').set(A(k1.token))).body.menuItems.map((i) => i.id)).not.toContain(item2.id);
        expect((await request(app).get('/api/daily-logs').set(A(k1.token))).body.logs.map((l) => l.id)).not.toContain(log2.id);
        expect((await request(app).get('/api/surplus-listings').set(A(k1.token))).body.listings.map((l) => l.id)).not.toContain(listing2.id);
        expect((await request(app).get('/api/notifications').set(A(k1.token))).body.notifications.map((n) => n.id)).not.toContain(notification2.id);
        expect((await request(app).get('/api/processing/products').set(A(k1.token))).body.data.map((p) => p.id)).not.toContain(item2.id);
    });

    it('kitchen one cannot read, change or delete kitchen two\'s daily log', async () => {
        expect((await request(app).get(`/api/daily-logs/${log2.id}`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).patch(`/api/daily-logs/${log2.id}`).set(A(k1.token)).send({ quantityPrepared: 1 })).status).toBe(403);
        expect((await request(app).delete(`/api/daily-logs/${log2.id}`).set(A(k1.token))).status).toBe(403);
        expect((await row('SELECT quantity_prepared FROM daily_logs WHERE id = $1', [log2.id])).quantity_prepared).toBe(50);
    });

    it('kitchen one cannot write logs, batches, forecasts or analysis against kitchen two\'s items', async () => {
        expect((await request(app).post('/api/daily-logs').set(A(k1.token)).send({ menuItemId: item2.id, logDate: '2026-03-02', mealSlot: 'LUNCH' })).status).toBe(403);
        const batch = await request(app).post('/api/processing/batches').set(A(k1.token)).send({ product_id: item2.id, log_date: '2026-03-02', input_quantity: 10, output_quantity: 8, rejects_quantity: 1 });
        expect(batch.status).toBe(404);
        expect((await request(app).get(`/api/forecasts/${item2.id}?targetDate=2026-03-05`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).get(`/api/root-causes/${log2.id}`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).post('/api/prevention/evaluate').set(A(k1.token)).send({ menuItemId: item2.id, targetDate: '2026-03-05', plannedQuantity: 5 })).status).toBe(403);
        expect((await request(app).post('/api/simulations/run').set(A(k1.token)).send({ menuItemId: item2.id, targetDate: '2026-03-05', proposedQuantity: 5 })).status).toBe(404);
        expect((await row('SELECT COUNT(*)::int AS n FROM daily_logs WHERE menu_item_id = $1', [item2.id])).n).toBe(1);
        expect((await row("SELECT COUNT(*)::int AS n FROM ai_simulations WHERE kitchen_org_id = $1", [k1.organization.id])).n).toBe(0);
    });

    it('kitchen one cannot approve or reject kitchen two\'s prevention recommendation', async () => {
        expect(recommendation2.recommendationId).toBeGreaterThan(0);
        const res = await request(app).patch(`/api/prevention/${recommendation2.recommendationId}/status`).set(A(k1.token)).send({ status: 'approved' });
        expect(res.status).toBe(400); // "not found or unauthorized"
        expect((await row('SELECT status FROM ai_prevention_recommendations WHERE id = $1', [recommendation2.recommendationId])).status).toBe('pending');
    });

    it('kitchen one cannot see, confirm, collect or match kitchen two\'s surplus listing', async () => {
        const id = listing2.id;
        expect((await request(app).get(`/api/surplus-listings/${id}`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).get(`/api/surplus-listings/${id}/spoilage-assessment`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).get(`/api/surplus-listings/${id}/ngo-matches`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).patch(`/api/surplus-listings/${id}/confirm-pickup`).set(A(k1.token)).send({ confirmedPickupTime: future(3) })).status).toBe(404);
        expect((await request(app).patch(`/api/surplus-listings/${id}/collect`).set(A(k1.token)).send({ quantityCollected: 1 })).status).toBe(403);
        const state = await row('SELECT status, confirmed_pickup_time FROM surplus_listings WHERE id = $1', [id]);
        expect(state).toEqual({ status: 'Claimed', confirmed_pickup_time: null });
        expect((await row('SELECT COUNT(*)::int AS n FROM transactions_log WHERE surplus_listing_id = $1', [id])).n).toBe(0);
    });

    it('an NGO that did not claim a listing cannot see or collect it, and NGOs cannot read match statistics', async () => {
        const id = listing2.id;
        expect((await request(app).get(`/api/surplus-listings/${id}`).set(A(ngo2.token))).status).toBe(403);
        expect((await request(app).patch(`/api/surplus-listings/${id}/collect`).set(A(ngo2.token)).send({ quantityCollected: 1 })).status).toBe(403);
        expect((await request(app).get(`/api/surplus-listings/${id}/ngo-matches`).set(A(ngo1.token))).status).toBe(403);
        expect((await request(app).get(`/api/surplus-listings/${id}`).set(A(ngo1.token))).status).toBe(200); // the claiming NGO may
    });

    it('a second NGO cannot take over an already-claimed listing', async () => {
        const res = await request(app).post(`/api/surplus-listings/${listing2.id}/claim`).set(A(ngo2.token)).send({ proposedPickupTime: future(2) });
        expect(res.status).toBe(409);
        expect((await row('SELECT claimed_by_ngo_id FROM surplus_listings WHERE id = $1', [listing2.id])).claimed_by_ngo_id).toBe(ngo1.organization.id);
    });

    it('cannot read or mark another user\'s notifications', async () => {
        expect((await request(app).patch(`/api/notifications/${notification2.id}/read`).set(A(k1.token))).status).toBe(404);
        expect((await row('SELECT is_read FROM notifications WHERE id = $1', [notification2.id])).is_read).toBe(false);
        await request(app).patch('/api/notifications/read-all').set(A(k1.token));
        expect((await row('SELECT is_read FROM notifications WHERE id = $1', [notification2.id])).is_read).toBe(false);
    });

    it('cannot read another organization, or verify or change one', async () => {
        expect((await request(app).get(`/api/organizations/${k2.organization.id}`).set(A(k1.token))).status).toBe(403);
        expect((await request(app).patch(`/api/organizations/${ngo1.organization.id}/verify`).set(A(k1.token)).send({ verificationStatus: 'rejected' })).status).toBe(403);
        expect((await request(app).patch(`/api/organizations/${ngo1.organization.id}/verify`).set(A(ngo1.token)).send({ verificationStatus: 'verified' })).status).toBe(403);
        expect((await row('SELECT verification_status FROM organizations WHERE id = $1', [ngo1.organization.id])).verification_status).toBe('verified');
    });

    it('financial impact, learning and waste analytics are scoped to the caller\'s own organization', async () => {
        await request(app).post('/api/daily-logs').set(A(k2.token)).send({ menuItemId: item2.id, logDate: new Date().toISOString().slice(0, 10), mealSlot: 'DINNER', quantityPrepared: 100, quantityLeftover: 40 });
        const impact = await request(app).get('/api/financial-impact?period=monthly').set(A(k1.token));
        expect(impact.status).toBe(200);
        expect(impact.body.data.totalEstimatedLoss).toBe(0);
        expect(JSON.stringify(impact.body)).not.toContain('K2 Rice');
        const attribution = await request(app).get('/api/analytics/waste-attribution').set(A(k1.token));
        expect(JSON.stringify(attribution.body)).not.toContain('K2 Rice');
        const learning = await request(app).post('/api/learning/evaluate').set(A(k1.token)).send({ targetDate: '2026-03-05' });
        expect(learning.body.data).toEqual([]);
        const performance = await request(app).get('/api/analytics/forecast-performance?startDate=2026-01-01&endDate=2026-12-31').set(A(k1.token));
        expect(JSON.stringify(performance.body)).not.toContain('K2 Rice');
    });

    it('lets a system admin read across organizations, as designed', async () => {
        expect((await request(app).get(`/api/forecasts/${item2.id}?targetDate=2026-03-05`).set(A(admin.token))).status).toBe(200);
        expect((await request(app).get(`/api/root-causes/${log2.id}`).set(A(admin.token))).status).toBe(200);
        expect((await request(app).get(`/api/organizations/${k2.organization.id}`).set(A(admin.token))).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// 6. Client-controlled organization / identity fields are never trusted
// ---------------------------------------------------------------------------

describe('no user-controlled organization_id or privilege fields', () => {
    it('creates records in the caller\'s own organization whatever organization ids the body carries', async () => {
        const item = await request(app).post('/api/menu-items').set(A(k1.token)).send({ name: 'Mass assign', unit: 'kg', kitchen_org_id: k2.organization.id, kitchenOrgId: k2.organization.id, organization_id: k2.organization.id });
        expect(item.body.menuItem.kitchen_org_id).toBe(k1.organization.id);
        const listing = await request(app).post('/api/surplus-listings').set(A(k1.token)).send({
            quantity: 5, foodType: 'Dal', safeUntilTime: future(4), kitchen_org_id: k2.organization.id, kitchenOrgId: k2.organization.id,
            status: 'Collected', claimed_by_ngo_id: ngo1.organization.id, claimed_by_user_id: 1,
        });
        expect(listing.body.listing).toMatchObject({ kitchen_org_id: k1.organization.id, status: 'Available', claimed_by_ngo_id: null });
    });

    it('ignores organization, type, verification and id fields when a user edits their own organization', async () => {
        const res = await request(app).patch('/api/organizations/me').set(A(ngo2.token)).send({
            name: 'NGO Two Renamed', id: k1.organization.id, type: 'kitchen', verification_status: 'rejected', organization_id: k1.organization.id, created_at: '2000-01-01',
        });
        expect(res.status).toBe(200);
        const after = (await pool.query('SELECT id, type, verification_status, name FROM organizations WHERE id IN ($1, $2) ORDER BY id', [k1.organization.id, ngo2.organization.id])).rows;
        expect(after.find((o) => o.id === ngo2.organization.id)).toMatchObject({ type: 'ngo', verification_status: 'verified', name: 'NGO Two Renamed' });
        expect(after.find((o) => o.id === k1.organization.id).name).toBe('Kitchen One');
    });

    it('does not let a new registration choose its own role or verification status', async () => {
        const email = uniqueEmail('mass');
        const res = await request(app).post('/api/auth/register-organization').send({
            organizationName: 'Sneaky NGO', organizationType: 'ngo', pincode: '1', name: 'n', email, password: 'password123',
            role: SA, verificationStatus: 'verified', verification_status: 'verified', is_active: true, organization_id: k1.organization.id,
        });
        expect(res.status).toBe(201);
        const created = (await pool.query('SELECT u.role, u.organization_id, o.verification_status FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.email = $1', [email])).rows[0];
        expect(created).toMatchObject({ role: NA, verification_status: 'pending' });
        expect(created.organization_id).not.toBe(k1.organization.id);
    });

    it('creates sub-users only inside the acting admin\'s organization, with roles of the same kind', async () => {
        const inOwnOrg = await request(app).post('/api/auth/users').set(A(k1.token)).send({ name: 'n', email: uniqueEmail('own'), password: 'password123', role: KS, organizationId: k2.organization.id });
        expect(inOwnOrg.status).toBe(201);
        expect(inOwnOrg.body.user.organization_id).toBe(k1.organization.id);
        expect((await request(app).post('/api/auth/users').set(A(k1.token)).send({ name: 'n', email: uniqueEmail('x'), password: 'password123', role: NA })).status).toBe(403);
        expect((await request(app).post('/api/auth/users').set(A(k1.token)).send({ name: 'n', email: uniqueEmail('x'), password: 'password123', role: SA })).status).toBe(403);
        expect((await request(app).post('/api/auth/users').set(A(ngo1.token)).send({ name: 'n', email: uniqueEmail('x'), password: 'password123', role: KM })).status).toBe(403);
        expect((await request(app).post('/api/auth/users').set(A(staff1.token)).send({ name: 'n', email: uniqueEmail('x'), password: 'password123', role: KS })).status).toBe(403);
        // A system admin's organization id is validated against the roles allowed for that organization type.
        expect((await request(app).post('/api/auth/users').set(A(admin.token)).send({ name: 'n', email: uniqueEmail('x'), password: 'password123', role: NA, organizationId: k1.organization.id })).status).toBe(400);
        expect((await request(app).post('/api/auth/users').set(A(admin.token)).send({ name: 'n', email: uniqueEmail('x'), password: 'password123', role: KS, organizationId: 1999999999 })).status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// 7. Vulnerabilities found by the audit (each fails on the pre-audit code)
// ---------------------------------------------------------------------------

describe('VULN-1: rescue priorities were readable by any authenticated user', () => {
    let listingId;
    let farNgo;
    let nearNgo;

    beforeAll(async () => {
        const kitchen = await registerKitchen({ organizationName: 'Geo Kitchen' });
        await pool.query('UPDATE organizations SET latitude = 28.61, longitude = 77.21 WHERE id = $1', [kitchen.organization.id]);
        farNgo = await registerNgo({ organizationName: 'Far NGO' });
        nearNgo = await registerNgo({ organizationName: 'Near NGO' });
        await verifyNgo(farNgo.organization.id, admin.token);
        await verifyNgo(nearNgo.organization.id, admin.token);
        await pool.query('UPDATE organizations SET latitude = 13.08, longitude = 80.27, service_radius_km = 5 WHERE id = $1', [farNgo.organization.id]);
        await pool.query('UPDATE organizations SET latitude = 28.62, longitude = 77.22, service_radius_km = 50 WHERE id = $1', [nearNgo.organization.id]);
        listingId = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 12, foodType: 'Khichdi', safeUntilTime: future(6) })).body.listing.id;
    });

    const priorities = (token) => request(app).get('/api/rescue-priorities').set(A(token));

    it('refuses every kitchen role (they would see other kitchens\' surplus)', async () => {
        expect((await priorities(k1.token)).status).toBe(403);
        expect((await priorities(staff1.token)).status).toBe(403);
    });

    it('refuses an NGO that is not verified, as the surplus feed does', async () => {
        const pending = await registerNgo({ organizationName: 'Pending NGO' });
        expect((await request(app).get('/api/surplus-listings/feed').set(A(pending.token))).status).toBe(403);
        expect((await priorities(pending.token)).status).toBe(403);
        const rejected = await registerNgo({ organizationName: 'Rejected NGO' });
        await request(app).patch(`/api/organizations/${rejected.organization.id}/verify`).set(A(admin.token)).send({ verificationStatus: 'rejected' });
        expect((await priorities(rejected.token)).status).toBe(403);
    });

    it('shows a verified NGO only listings inside its own service area, without kitchen coordinates', async () => {
        const near = await priorities(nearNgo.token);
        expect(near.status).toBe(200);
        expect(near.body.data.map((l) => l.id)).toContain(listingId);
        near.body.data.forEach((l) => {
            expect(Object.keys(l)).not.toEqual(expect.arrayContaining(['kitchen_latitude']));
            expect(l).not.toHaveProperty('kitchen_latitude');
            expect(l).not.toHaveProperty('kitchen_longitude');
        });
        const far = await priorities(farNgo.token);
        expect(far.status).toBe(200);
        expect(far.body.data.map((l) => l.id)).not.toContain(listingId);
    });

    it('lets a system admin see all of them', async () => {
        const all = await priorities(admin.token);
        expect(all.status).toBe(200);
        expect(all.body.data.map((l) => l.id)).toContain(listingId);
    });

    it('does not leak internal error text if it fails', async () => {
        const spy = jest.spyOn(pool, 'query').mockRejectedValue(new Error('connection to server at "10.1.2.3" failed: password authentication failed for user "postgres"'));
        try {
            const res = await request(app).get('/api/rescue-priorities').set(A(admin.token));
            expect(res.status).toBe(500);
            expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|password authentication|postgres/);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('VULN-2: an NGO could claim a listing outside its service area by guessing the id', () => {
    it('refuses a claim from outside the service area and leaves the listing available', async () => {
        const kitchen = await registerKitchen({ organizationName: 'Delhi Kitchen' });
        await pool.query('UPDATE organizations SET latitude = 28.61, longitude = 77.21 WHERE id = $1', [kitchen.organization.id]);
        const listing = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 10, foodType: 'Rice', safeUntilTime: future(6) })).body.listing;
        const chennai = await registerNgo({ organizationName: 'Chennai NGO' });
        await verifyNgo(chennai.organization.id, admin.token);
        await pool.query('UPDATE organizations SET latitude = 13.08, longitude = 80.27, service_radius_km = 5 WHERE id = $1', [chennai.organization.id]);

        expect((await request(app).get('/api/surplus-listings/feed').set(A(chennai.token))).body.listings.map((l) => l.id)).not.toContain(listing.id);
        const res = await request(app).post(`/api/surplus-listings/${listing.id}/claim`).set(A(chennai.token)).send({ proposedPickupTime: future(2) });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/service area/);
        expect(res.body).not.toHaveProperty('listing');
        expect((await pool.query('SELECT status, claimed_by_ngo_id FROM surplus_listings WHERE id = $1', [listing.id])).rows[0]).toEqual({ status: 'Available', claimed_by_ngo_id: null });
    });

    it('still lets an NGO inside its service area, or with no location configured, claim', async () => {
        const kitchen = await registerKitchen({ organizationName: 'Delhi Kitchen 2' });
        await pool.query('UPDATE organizations SET latitude = 28.61, longitude = 77.21 WHERE id = $1', [kitchen.organization.id]);
        const local = await registerNgo({ organizationName: 'Local NGO' });
        const nowhere = await registerNgo({ organizationName: 'Unlocated NGO' });
        await verifyNgo(local.organization.id, admin.token);
        await verifyNgo(nowhere.organization.id, admin.token);
        await pool.query('UPDATE organizations SET latitude = 28.62, longitude = 77.20, service_radius_km = 20 WHERE id = $1', [local.organization.id]);
        const first = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 10, foodType: 'Rice', safeUntilTime: future(6) })).body.listing;
        const second = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 10, foodType: 'Rice', safeUntilTime: future(6) })).body.listing;
        expect((await request(app).post(`/api/surplus-listings/${first.id}/claim`).set(A(local.token)).send({ proposedPickupTime: future(2) })).status).toBe(200);
        expect((await request(app).post(`/api/surplus-listings/${second.id}/claim`).set(A(nowhere.token)).send({ proposedPickupTime: future(2) })).status).toBe(200);
    });

    it('answers 409 for a listing that does not exist or is gone, as before', async () => {
        const res = await request(app).post(`/api/surplus-listings/${NONEXISTENT_ID}/claim`).set(A(ngo1.token)).send({ proposedPickupTime: future(2) });
        expect(res.status).toBe(409);
    });
});

describe('VULN-3: an NGO or kitchen could record more food collected than was listed', () => {
    let kitchen;
    let listing;

    beforeAll(async () => {
        kitchen = await registerKitchen({ organizationName: 'Collect Kitchen' });
        listing = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 10, foodType: 'Rice', safeUntilTime: future(6) })).body.listing;
        await request(app).post(`/api/surplus-listings/${listing.id}/claim`).set(A(ngo1.token)).send({ proposedPickupTime: future(2) });
    });

    it('rejects a collected quantity above the listed quantity and records nothing', async () => {
        for (const who of [ngo1.token, kitchen.token]) {
            const res = await request(app).patch(`/api/surplus-listings/${listing.id}/collect`).set(A(who)).send({ quantityCollected: 100000 });
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/more than the listed quantity/);
        }
        expect((await pool.query('SELECT status FROM surplus_listings WHERE id = $1', [listing.id])).rows[0].status).toBe('Claimed');
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM transactions_log WHERE surplus_listing_id = $1', [listing.id])).rows[0].n).toBe(0);
    });

    it('accepts a quantity up to the listed amount and records exactly it', async () => {
        const res = await request(app).patch(`/api/surplus-listings/${listing.id}/collect`).set(A(ngo1.token)).send({ quantityCollected: 10 });
        expect(res.status).toBe(200);
        expect((await pool.query('SELECT quantity_collected FROM transactions_log WHERE surplus_listing_id = $1', [listing.id])).rows[0].quantity_collected).toBe(10);
    });
});

describe('VULN-4: malformed ids, dates, numbers and pagination produced 500s and raw database errors', () => {
    const BIG = '99999999999';
    const notInternal = (res) => expect(JSON.stringify(res.body)).not.toMatch(/invalid input syntax|out of range for type|violates|pg_|relation "|syntax error/i);

    it.each([
        ['GET', '/api/menu-items/abc', 'k1'], ['GET', `/api/menu-items/${BIG}`, 'k1'], ['PATCH', `/api/menu-items/${BIG}`, 'k1'], ['DELETE', '/api/menu-items/0', 'k1'],
        ['GET', `/api/daily-logs/${BIG}`, 'k1'], ['PATCH', '/api/daily-logs/-1', 'k1'], ['DELETE', `/api/daily-logs/${BIG}`, 'k1'],
        ['GET', `/api/surplus-listings/${BIG}`, 'k1'], ['GET', '/api/surplus-listings/abc/spoilage-assessment', 'k1'],
        ['POST', `/api/surplus-listings/${BIG}/claim`, 'ngo'], ['PATCH', `/api/surplus-listings/${BIG}/confirm-pickup`, 'k1'], ['PATCH', `/api/surplus-listings/${BIG}/collect`, 'k1'],
        ['GET', `/api/surplus-listings/${BIG}/ngo-matches`, 'k1'], ['PATCH', `/api/notifications/${BIG}/read`, 'k1'], ['PATCH', '/api/notifications/abc/read', 'k1'],
        ['GET', '/api/root-causes/abc', 'k1'], ['GET', `/api/root-causes/${BIG}`, 'k1'], ['GET', '/api/forecasts/abc', 'k1'], ['GET', `/api/forecasts/${BIG}`, 'k1'],
        ['PATCH', '/api/prevention/abc/status', 'k1'], ['PATCH', `/api/prevention/${BIG}/status`, 'k1'], ['DELETE', `/api/events/${BIG}`, 'k1'],
    ])('%s %s answers 400 with no internal error text', async (method, url, who) => {
        const res = await request(app)[method.toLowerCase()](url).set(A(who === 'ngo' ? ngo1.token : k1.token)).send({});
        expect(res.status).toBe(400);
        notInternal(res);
    });

    it('validates ids on the admin-only organization routes', async () => {
        expect((await request(app).get(`/api/organizations/${BIG}`).set(A(admin.token))).status).toBe(400);
        expect((await request(app).get('/api/organizations/abc').set(A(admin.token))).status).toBe(400);
        expect((await request(app).patch(`/api/organizations/${BIG}/verify`).set(A(admin.token)).send({ verificationStatus: 'verified' })).status).toBe(400);
    });

    it.each([
        ['/api/organizations?limit=-1'], ['/api/organizations?limit=abc'], ['/api/organizations?limit=1000000000'], ['/api/organizations?offset=-1'], ['/api/organizations?type=hacker'],
        ['/api/organizations/pending-ngos?limit=0'],
        ['/api/daily-logs?limit=-5'], ['/api/daily-logs?limit=201'], ['/api/daily-logs?startDate=garbage'], ['/api/daily-logs?endDate=2026-02-30'], ['/api/daily-logs?menuItemId=abc'], ['/api/daily-logs?mealSlot=BRUNCH'],
        ['/api/notifications?limit=abc'], ['/api/notifications?unreadOnly=maybe'], ['/api/surplus-listings?limit=abc'], ['/api/surplus-listings?status=Hacked'],
    ])('GET %s is refused with 400', async (url) => {
        const token = url.startsWith('/api/organizations') ? admin.token : k1.token;
        const res = await request(app).get(url).set(A(token));
        expect(res.status).toBe(400);
        notInternal(res);
    });

    it('still accepts sensible pagination and filters', async () => {
        expect((await request(app).get('/api/daily-logs?limit=200&offset=0&startDate=2026-01-01&endDate=2026-12-31&mealSlot=LUNCH').set(A(k1.token))).status).toBe(200);
        expect((await request(app).get('/api/organizations?limit=100&type=ngo&verificationStatus=verified').set(A(admin.token))).status).toBe(200);
        expect((await request(app).get('/api/notifications?unreadOnly=true&limit=10').set(A(k1.token))).status).toBe(200);
    });

    it.each([
        ['impossible date', { menuItemId: 1, logDate: '2026-02-30', mealSlot: 'LUNCH' }],
        ['week date', { menuItemId: 1, logDate: '2026-W05-1', mealSlot: 'LUNCH' }],
        ['datetime as date', { menuItemId: 1, logDate: '2026-03-01T10:00:00Z', mealSlot: 'LUNCH' }],
        ['huge menuItemId', { menuItemId: 99999999999, logDate: '2026-03-01', mealSlot: 'LUNCH' }],
        ['overflowing quantity', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityPrepared: '1e999' }],
        ['absurd quantity', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityPrepared: 1e12 }],
        ['array quantity', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityPrepared: [1, 2] }],
        ['object quantity', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityLeftover: { $gt: 0 } }],
        ['fractional headcount', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', headcount: 1.5 }],
        ['huge headcount', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', headcount: 99999999999 }],
        ['negative quantity', { menuItemId: 1, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityConsumed: -1 }],
    ])('daily log with %s is refused with 400 before reaching the database', async (_name, body) => {
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM daily_logs')).rows[0].n;
        const res = await request(app).post('/api/daily-logs').set(A(k1.token)).send(body);
        expect(res.status).toBe(400);
        notInternal(res);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM daily_logs')).rows[0].n).toBe(before);
    });

    it('stores a valid daily log unchanged', async () => {
        const item = (await request(app).post('/api/menu-items').set(A(k1.token)).send({ name: 'Valid Rice', unit: 'kg' })).body.menuItem;
        const res = await request(app).post('/api/daily-logs').set(A(k1.token)).send({ menuItemId: item.id, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityPrepared: '12.5', quantityLeftover: 2, headcount: 30 });
        expect(res.status).toBe(201);
        expect(res.body.log).toMatchObject({ log_date: '2026-03-01', quantity_prepared: 12.5, quantity_leftover: 2, headcount: 30 });
    });

    it.each([
        ['array name', { name: ['a', 'b'], unit: 'kg' }],
        ['object name', { name: { a: 1 }, unit: 'kg' }],
        ['very long name', { name: 'x'.repeat(5000), unit: 'kg' }],
        ['long unit', { name: 'x', unit: 'u'.repeat(60) }],
        ['array cost', { name: 'x', unit: 'kg', costPerUnit: [1, 2] }],
        ['object cost', { name: 'x', unit: 'kg', costPerUnit: { a: 1 } }],
        ['overflowing cost', { name: 'x', unit: 'kg', costPerUnit: '1e999' }],
        ['negative cost', { name: 'x', unit: 'kg', preparationCostPerUnit: -1 }],
        ['blank name', { name: '   ', unit: 'kg' }],
    ])('menu item with %s is refused with 400 and nothing is stored', async (_name, body) => {
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM menu_items')).rows[0].n;
        const res = await request(app).post('/api/menu-items').set(A(k1.token)).send(body);
        expect(res.status).toBe(400);
        notInternal(res);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM menu_items')).rows[0].n).toBe(before);
    });

    it.each([
        ['long food type', { quantity: 1, foodType: 'x'.repeat(500), safeUntilTime: future() }],
        ['array food type', { quantity: 1, foodType: ['a'], safeUntilTime: future() }],
        ['overflowing quantity', { quantity: '1e999', foodType: 'Rice', safeUntilTime: future() }],
        ['huge daily log id', { quantity: 1, foodType: 'Rice', safeUntilTime: future(), dailyLogId: 99999999999 }],
        ['week-date time', { quantity: 1, foodType: 'Rice', safeUntilTime: '2026-W05-1' }],
        ['bare date as time', { quantity: 1, foodType: 'Rice', safeUntilTime: '2026-03-01' }],
        ['impossible time', { quantity: 1, foodType: 'Rice', safeUntilTime: '2026-02-30T10:00:00Z' }],
        ['array prepared time', { quantity: 1, foodType: 'Rice', preparedTime: ['x'] }],
    ])('surplus listing with %s is refused with 400', async (_name, body) => {
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM surplus_listings')).rows[0].n;
        const res = await request(app).post('/api/surplus-listings').set(A(k1.token)).send(body);
        expect(res.status).toBe(400);
        notInternal(res);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM surplus_listings')).rows[0].n).toBe(before);
    });

    it('refuses bad claim / confirm / collect payloads', async () => {
        expect((await request(app).post('/api/surplus-listings/1/claim').set(A(ngo1.token)).send({ proposedPickupTime: 'soon' })).status).toBe(400);
        expect((await request(app).patch('/api/surplus-listings/1/confirm-pickup').set(A(k1.token)).send({ confirmedPickupTime: ['x'] })).status).toBe(400);
        expect((await request(app).patch('/api/surplus-listings/1/collect').set(A(k1.token)).send({ quantityCollected: '1e999' })).status).toBe(400);
        expect((await request(app).patch('/api/surplus-listings/1/collect').set(A(k1.token)).send({ quantityCollected: 0 })).status).toBe(400);
    });

    it('validates registration and organization fields (type, length, password bounds)', async () => {
        const valid = { organizationName: 'Org', organizationType: 'kitchen', pincode: '1', name: 'n', email: uniqueEmail('v'), password: 'password123' };
        expect((await request(app).post('/api/auth/register-organization').send({ ...valid, organizationName: ['a'] })).status).toBe(400);
        expect((await request(app).post('/api/auth/register-organization').send({ ...valid, organizationName: 'x'.repeat(300) })).status).toBe(400);
        expect((await request(app).post('/api/auth/register-organization').send({ ...valid, pincode: { a: 1 } })).status).toBe(400);
        expect((await request(app).post('/api/auth/register-organization').send({ ...valid, password: 'p'.repeat(500) })).status).toBe(400);
        expect((await request(app).post('/api/auth/register-organization').send({ ...valid, email: ['a@b.co'] })).status).toBe(400);
        expect((await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: ['x'] })).status).toBe(400);
        expect((await request(app).patch('/api/organizations/me').set(A(k1.token)).send({ name: 'x'.repeat(300) })).status).toBe(400);
        expect((await request(app).patch('/api/organizations/me').set(A(k1.token)).send({ capacity_kg: [1] })).status).toBe(400);
        expect((await request(app).patch('/api/organizations/me').set(A(k1.token)).send({ preferred_food_types: 'rice' })).status).toBe(400);
    });

    it('prevention: refuses a bad menu item id, date or planned quantity and stores nothing', async () => {
        const item = (await request(app).post('/api/menu-items').set(A(k1.token)).send({ name: 'Prev Item', unit: 'kg' })).body.menuItem;
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM ai_prevention_recommendations')).rows[0].n;
        const ok = { menuItemId: item.id, targetDate: '2026-03-05', plannedQuantity: 5 };
        for (const bad of [{ menuItemId: 'abc' }, { menuItemId: BIG }, { menuItemId: [1] }, { targetDate: 'garbage' }, { targetDate: '2026-02-30' }, { targetDate: '2026-03-05T00:00:00Z' },
            { plannedQuantity: 'abc' }, { plannedQuantity: -5 }, { plannedQuantity: '1e999' }, { plannedQuantity: [5] }, { plannedQuantity: true }, { plannedQuantity: 1e12 }]) {
            const res = await request(app).post('/api/prevention/evaluate').set(A(k1.token)).send({ ...ok, ...bad });
            expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
            notInternal(res);
        }
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM ai_prevention_recommendations')).rows[0].n).toBe(before);
        const good = await request(app).post('/api/prevention/evaluate').set(A(k1.token)).send(ok);
        expect(good.status).toBe(200);
        expect(good.body.data.plannedQuantity).toBe(5);
    });

    it('simulation: refuses bad input with 400 and logs nothing; a valid run still works', async () => {
        const item = (await request(app).post('/api/menu-items').set(A(k1.token)).send({ name: 'Sim Item', unit: 'kg', costPerUnit: 2 })).body.menuItem;
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM ai_simulations')).rows[0].n;
        const ok = { menuItemId: item.id, targetDate: '2026-03-05', proposedQuantity: 5 };
        for (const bad of [{ menuItemId: 'abc' }, { menuItemId: BIG }, { targetDate: 'x' }, { targetDate: '2026-13-01' }, { proposedQuantity: 'abc' }, { proposedQuantity: -5 }, { proposedQuantity: [1] }, { proposedQuantity: 1e12 }]) {
            const res = await request(app).post('/api/simulations/run').set(A(k1.token)).send({ ...ok, ...bad });
            expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
        }
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM ai_simulations')).rows[0].n).toBe(before);
        expect((await request(app).post('/api/simulations/run').set(A(k1.token)).send(ok)).status).toBe(200);
    });

    it('learning: refuses a bad date with 400; financial impact refuses a bad period', async () => {
        for (const targetDate of ['garbage', '2026-02-30', ['2026-03-05'], 20260305]) {
            expect((await request(app).post('/api/learning/evaluate').set(A(k1.token)).send({ targetDate })).status).toBe(400);
        }
        expect((await request(app).post('/api/learning/evaluate').set(A(k1.token)).send({ targetDate: '2026-03-05' })).status).toBe(200);
        expect((await request(app).get('/api/financial-impact?period=yearly').set(A(k1.token))).status).toBe(400);
        expect((await request(app).get("/api/financial-impact?period=daily' OR '1'='1").set(A(k1.token))).status).toBe(400);
    });

    it('processing: refuses an oversized product id', async () => {
        const res = await request(app).post('/api/processing/batches').set(A(k1.token)).send({ product_id: BIG, log_date: '2026-03-05', input_quantity: 10 });
        expect(res.status).toBe(400);
        notInternal(res);
    });
});

describe('VULN-5: malformed or oversized request bodies answered 500', () => {
    it('answers 400 for malformed JSON and 413 for an oversized body', async () => {
        const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ');
        expect(bad.status).toBe(400);
        expect(bad.body.message).toMatch(/not valid JSON/);
        // The global JSON body limit is 600kb (raised from 100kb in Task 16 to admit food-quality image screening
        // payloads - see app.js), so this needs to comfortably exceed that, not the old 100kb figure.
        const huge = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(700000) }));
        expect(huge.status).toBe(413);
    });

    it('never returns database error text for unexpected failures (generic 500 on every legacy route)', async () => {
        const secretText = 'FATAL: password authentication failed for user "postgres" at 10.9.8.7';
        const item = (await request(app).post('/api/menu-items').set(A(k1.token)).send({ name: 'Err Item', unit: 'kg' })).body.menuItem;
        const log = (await request(app).post('/api/daily-logs').set(A(k1.token)).send({ menuItemId: item.id, logDate: '2026-03-01', mealSlot: 'LUNCH', quantityPrepared: 10, quantityLeftover: 5 })).body.log;
        const attempts = [
            () => request(app).get(`/api/forecasts/${item.id}?targetDate=2026-03-05`).set(A(k1.token)),
            () => request(app).get(`/api/root-causes/${log.id}`).set(A(k1.token)),
            () => request(app).post('/api/prevention/evaluate').set(A(k1.token)).send({ menuItemId: item.id, targetDate: '2026-03-05', plannedQuantity: 5 }),
            () => request(app).post('/api/simulations/run').set(A(k1.token)).send({ menuItemId: item.id, targetDate: '2026-03-05', proposedQuantity: 5 }),
            () => request(app).get('/api/financial-impact').set(A(k1.token)),
            () => request(app).post('/api/learning/evaluate').set(A(k1.token)).send({ targetDate: '2026-03-05' }),
            () => request(app).get('/api/organizations').set(A(k1.token)),
            () => request(app).get('/api/menu-items').set(A(k1.token)),
        ];
        for (const attempt of attempts) {
            // Let authentication succeed, then make every later query fail with an internal-looking error.
            const realQuery = pool.query.bind(pool);
            let calls = 0;
            const spy = jest.spyOn(pool, 'query').mockImplementation((...args) => {
                calls += 1;
                return calls <= 1 ? realQuery(...args) : Promise.reject(Object.assign(new Error(secretText), { code: 'XX000' }));
            });
            let res;
            try {
                res = await attempt();
            } finally {
                spy.mockRestore();
            }
            expect(res.status).toBe(500);
            expect(JSON.stringify(res.body)).not.toMatch(/password authentication|postgres|10\.9\.8\.7|FATAL/);
        }
    });

    it('maps stray database data errors to 400 without echoing them', async () => {
        const errorHandler = require('../src/middleware/errorHandler');
        const reply = (err) => {
            const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
            errorHandler(err, {}, res, () => {});
            return res;
        };
        [['22003', 'value "99999999999" is out of range for type integer'], ['22P02', 'invalid input syntax for type integer: "abc"'], ['22001', 'value too long for type character varying(50)'], ['23503', 'insert violates foreign key constraint "fk_x"']].forEach(([code, message]) => {
            const res = reply(Object.assign(new Error(message), { code }));
            expect(res.statusCode).toBe(400);
            expect(JSON.stringify(res.body)).not.toContain(message);
        });
        const unique = reply(Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' }));
        expect(unique.statusCode).toBe(409);
        const unknown = reply(new Error('boom: secret detail'));
        expect(unknown.statusCode).toBe(500);
        expect(JSON.stringify(unknown.body)).not.toContain('secret detail');
    });
});

describe('VULN-6: information disclosure through headers and the health check', () => {
    it('does not advertise the framework and marks responses as uncacheable and non-sniffable', async () => {
        const res = await request(app).get('/api/health');
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        const authed = await request(app).get('/api/auth/me').set(A(k1.token));
        expect(authed.headers['cache-control']).toBe('no-store');
    });

    it('does not put the database error in the health response', async () => {
        const spy = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 (user postgres)'));
        try {
            const res = await request(app).get('/api/health');
            expect(res.status).toBe(503);
            expect(res.body).toEqual({ status: 'error', database: 'disconnected' });
        } finally {
            spy.mockRestore();
        }
    });
});

describe('VULN-7: an account with no organization must never match "no claimer"', () => {
    it('does not treat a null organization as the claimer or owner of an unclaimed listing', async () => {
        const surplusService = require('../src/services/surplusListingService');
        const kitchen = await registerKitchen({ organizationName: 'Null Org Kitchen' });
        const listing = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 3, foodType: 'Rice', safeUntilTime: future() })).body.listing;
        expect(listing.claimed_by_ngo_id).toBeNull();
        await expect(surplusService.getListingById({ id: 1, role: SA, organizationId: null }, listing.id)).rejects.toMatchObject({ statusCode: 403 });
        await expect(surplusService.getListingById({ id: 1, role: KM, organizationId: undefined }, listing.id)).rejects.toMatchObject({ statusCode: 403 });
        await expect(surplusService.getListingById({ id: 1, role: KM, organizationId: kitchen.organization.id }, listing.id)).resolves.toMatchObject({ id: listing.id });
    });
});

// ---------------------------------------------------------------------------
// 8. Sensitive data never leaves the API
// ---------------------------------------------------------------------------

describe('sensitive data leakage', () => {
    const FORBIDDEN = /password|password_hash|passwordHash|\$2[aby]\$/i;

    it('never returns password hashes from any account endpoint', async () => {
        const email = uniqueEmail('leak');
        const responses = [
            await request(app).post('/api/auth/register-organization').send({ organizationName: 'Leak Org', organizationType: 'kitchen', pincode: '1', name: 'n', email, password: 'password123' }),
            await request(app).post('/api/auth/login').send({ email, password: 'password123' }),
            await request(app).get('/api/auth/me').set(A(k1.token)),
            await request(app).post('/api/auth/users').set(A(k1.token)).send({ name: 'n', email: uniqueEmail('leak2'), password: 'password123', role: KS }),
            await request(app).get('/api/organizations/me').set(A(k1.token)),
            await request(app).get('/api/organizations').set(A(admin.token)),
            await request(app).get('/api/organizations/pending-ngos').set(A(admin.token)),
            await request(app).patch('/api/organizations/me').set(A(k1.token)).send({ name: 'Kitchen One' }),
        ];
        responses.forEach((res) => expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN));
    });

    it('does not reveal whether an email exists through the login error, and gives no hint about which field was wrong', async () => {
        const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'password123' });
        const wrong = await request(app).post('/api/auth/login').send({ email: k1.user.email, password: 'wrong-password' });
        expect(unknown.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(unknown.body).toEqual(wrong.body);
        const inactive = await request(app).post('/api/auth/login').send({ email: (await pool.query('SELECT email FROM users WHERE is_active = false LIMIT 1')).rows[0].email, password: 'password123' });
        expect(inactive.status).toBe(401);
        expect(inactive.body).toEqual(wrong.body);
    });

    it('does not put user contact details into the surplus feed, listings or match results', async () => {
        const kitchen = await registerKitchen({ organizationName: 'Contact Kitchen' });
        const listing = (await request(app).post('/api/surplus-listings').set(A(kitchen.token)).send({ quantity: 4, foodType: 'Dal', safeUntilTime: future() })).body.listing;
        const feed = await request(app).get('/api/surplus-listings/feed').set(A(ngo1.token));
        const matches = await request(app).get(`/api/surplus-listings/${listing.id}/ngo-matches`).set(A(kitchen.token));
        const priorities = await request(app).get('/api/rescue-priorities').set(A(ngo1.token));
        [feed, matches, priorities].forEach((res) => {
            expect(res.status).toBe(200);
            expect(JSON.stringify(res.body)).not.toMatch(/@example\.com|password/i);
        });
    });

    it('unknown routes answer a plain 404 without stack traces', async () => {
        const res = await request(app).get('/api/does-not-exist').set(A(k1.token));
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js|node_modules|stack/i);
    });
});
