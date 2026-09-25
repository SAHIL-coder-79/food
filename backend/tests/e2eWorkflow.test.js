const path = require('path');
const { execFileSync, spawn } = require('child_process');
const request = require('supertest');
const { app, pool, resetDb, uniqueEmail, localDateString } = require('./testHelpers');
const { mulberry32 } = require('./helpers/forecastFixtures');

// End-to-end workflow: the whole product loop through the real HTTP API and a real database (no mocks):
//   kitchen -> menu -> logs -> forecast -> root cause -> prevention -> surplus -> rescue priority -> NGO verification
//   -> matching -> claim -> pickup -> collect -> financial/environmental impact -> simulator -> processing
//   -> waste attribution -> forecast-vs-actual -> learning -> event-aware forecast.
// Steps run in the order below and share state; a failed step is reported with its number.

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const get = (url, token) => request(app).get(url).set(auth(token));
const post = (url, token, body = {}) => request(app).post(url).set(auth(token)).send(body);
const patch = (url, token, body = {}) => request(app).patch(url).set(auth(token)).send(body);
const del = (url, token) => request(app).delete(url).set(auth(token));

const TODAY = localDateString(0);
const YESTERDAY = localDateString(-1);
const HISTORY_DAYS = 30; // T-30 .. T-1
const KITCHEN_GEO = { latitude: 28.6139, longitude: 77.209 }; // Delhi
const WEEKDAY = [0.7, 1.15, 1.1, 1.0, 1.0, 1.05, 0.8]; // Sun..Sat demand shape
const COST = { thali: { cost: 45, prep: 8 }, product: { cost: 30, prep: 5 } };
const future = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
const round1 = (v) => Math.round(v * 10) / 10;

const ctx = {}; // state shared across steps
// Set E2E_DUMP=<file> to write the key responses of the run to a JSON file for manual review.
const dumped = {};
const dump = (name, value) => {
    if (process.env.E2E_DUMP) dumped[name] = value;
};
const report = []; // one line per step, printed at the end
const step = (n, name, detail = '') => report.push(`${String(n).padStart(2)}. ${name}${detail ? ` - ${detail}` : ''}`);

// Deterministic realistic history for the main dish: weekday pattern, noisy demand, headcount, ~15% leftover, some
// sold-out days, and one badly over-prepared low-attendance day.
function buildHistory() {
    const rng = mulberry32(2026);
    const rows = [];
    for (let back = HISTORY_DAYS; back >= 1; back -= 1) {
        const date = localDateString(-back);
        const weekday = new Date(`${date}T00:00:00`).getDay();
        const demand = Math.round(112 * WEEKDAY[weekday] * (1 + (rng() - 0.5) * 0.12));
        const headcount = Math.round(demand / 0.92);
        let planned = Math.round(demand * 1.2);
        let prepared = Math.round(demand * (1.12 + rng() * 0.08));
        let consumed = demand;
        let leftover = prepared - consumed;
        let hc = headcount;
        if (back % 9 === 0) { // sold out: everything prepared was eaten, nothing left
            prepared = Math.round(demand * 0.93);
            consumed = prepared;
            leftover = 0;
            planned = prepared;
        }
        if (back === 10) { // the wasteful day: planned 150, prepared 230, only 60 people came
            planned = 150;
            prepared = 230;
            hc = 60;
            consumed = 110;
            leftover = 120;
        }
        rows.push({ date, weekday, planned, prepared, consumed, leftover, headcount: hc, demand });
    }
    return rows;
}

let registeredEmail;
let adminToken;

beforeAll(async () => {
    await resetDb();
}, 60000);

afterAll(async () => {
    if (process.env.E2E_DUMP) require('fs').writeFileSync(process.env.E2E_DUMP, JSON.stringify(dumped, null, 1));
    process.stdout.write(`\n\n===== E2E WORKFLOW REPORT =====\n${report.join('\n')}\n===============================\n`);
    await pool.end();
});

describe('E2E workflow: kitchen -> forecast -> prevention -> rescue -> impact -> learning', () => {
    it('1. registers a kitchen', async () => {
        registeredEmail = uniqueEmail('kitchen');
        const res = await request(app).post('/api/auth/register-organization').send({
            organizationName: 'Annapurna Community Kitchen', organizationType: 'kitchen', pincode: '110001', ...KITCHEN_GEO,
            name: 'Meera Sharma', email: registeredEmail, password: 'Str0ng-Passw0rd!',
        });
        expect(res.status).toBe(201);
        expect(res.body.user).toMatchObject({ role: 'KITCHEN_MANAGER', email: registeredEmail });
        expect(res.body.organization).toMatchObject({ type: 'kitchen', verification_status: 'verified' });
        expect(res.body.token).toEqual(expect.any(String));
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
        ctx.kitchenOrgId = res.body.organization.id;
        step(1, 'Register kitchen', `org ${ctx.kitchenOrgId}, manager account created, kitchen auto-verified`);
    });

    it('2. logs in, and the manager creates a staff account who can also log in', async () => {
        const res = await request(app).post('/api/auth/login').send({ email: registeredEmail, password: 'Str0ng-Passw0rd!' });
        expect(res.status).toBe(200);
        ctx.manager = res.body.token;
        const me = await get('/api/auth/me', ctx.manager);
        expect(me.body.user).toMatchObject({ role: 'KITCHEN_MANAGER', organizationId: ctx.kitchenOrgId });
        expect((await request(app).post('/api/auth/login').send({ email: registeredEmail, password: 'wrong-password' })).status).toBe(401);

        const staffEmail = uniqueEmail('staff');
        const created = await post('/api/auth/users', ctx.manager, { name: 'Ravi Kumar', email: staffEmail, password: 'Str0ng-Passw0rd!', role: 'KITCHEN_STAFF' });
        expect(created.status).toBe(201);
        const staffLogin = await request(app).post('/api/auth/login').send({ email: staffEmail, password: 'Str0ng-Passw0rd!' });
        ctx.staff = staffLogin.body.token;
        expect(ctx.staff).toEqual(expect.any(String));
        step(2, 'Login', 'manager + staff sessions, bad password rejected');
    });

    it('3. creates menu items with costs', async () => {
        const thali = await post('/api/menu-items', ctx.manager, { name: 'Veg Thali', unit: 'servings', costPerUnit: COST.thali.cost, preparationCostPerUnit: COST.thali.prep });
        expect(thali.status).toBe(201);
        ctx.thali = thali.body.menuItem;
        const chapati = await post('/api/menu-items', ctx.manager, { name: 'Chapati', unit: 'pieces', costPerUnit: 4, preparationCostPerUnit: 1 });
        expect(chapati.status).toBe(201);
        ctx.chapati = chapati.body.menuItem;
        expect(ctx.thali.kitchen_org_id).toBe(ctx.kitchenOrgId);
        expect((await get('/api/menu-items', ctx.staff)).body.menuItems).toHaveLength(2);
        step(3, 'Create menu items', 'Veg Thali (servings), Chapati (pieces), both in the kitchen\'s own organization');
    });

    it('4. staff record 30 days of realistic daily logs (plus a second meal slot)', async () => {
        ctx.history = buildHistory();
        ctx.logIds = {};
        for (const day of ctx.history) {
            const res = await post('/api/daily-logs', ctx.staff, {
                menuItemId: ctx.thali.id, logDate: day.date, mealSlot: 'LUNCH', quantityPlanned: day.planned, quantityPrepared: day.prepared,
                headcount: day.headcount, quantityConsumed: day.consumed, quantityLeftover: day.leftover,
            });
            expect(res.status).toBe(201);
            ctx.logIds[day.date] = res.body.log.id;
        }
        // Chapati is served at lunch and dinner for the last 10 days.
        for (let back = 10; back >= 1; back -= 1) {
            for (const [slot, made] of [['LUNCH', 120], ['DINNER', 90]]) {
                const res = await post('/api/daily-logs', ctx.staff, { menuItemId: ctx.chapati.id, logDate: localDateString(-back), mealSlot: slot, quantityPlanned: made, quantityPrepared: made, quantityConsumed: made - 8, quantityLeftover: 8 });
                expect(res.status).toBe(201);
            }
        }
        const list = await get('/api/daily-logs?limit=200', ctx.manager);
        expect(list.body.logs).toHaveLength(HISTORY_DAYS + 20);
        expect((await get('/api/daily-logs?menuItemId=' + ctx.chapati.id + '&mealSlot=DINNER', ctx.manager)).body.logs).toHaveLength(10);
        // Duplicate slot for the same day is refused, not silently doubled.
        const dupe = await post('/api/daily-logs', ctx.staff, { menuItemId: ctx.thali.id, logDate: YESTERDAY, mealSlot: 'LUNCH', quantityPrepared: 1 });
        expect(dupe.status).toBe(409);
        step(4, 'Create daily logs', `${HISTORY_DAYS} days x Veg Thali + 20 Chapati logs (2 slots), duplicate slot rejected with 409`);
    });

    it('5. generates a context-aware forecast for today, stored and explained', async () => {
        const res = await get(`/api/forecasts/${ctx.thali.id}?targetDate=${TODAY}`, ctx.manager);
        expect(res.status).toBe(200);
        const f = res.body.data;
        ctx.forecast = f;
        dump('5 forecast', f);
        expect(f.modelVersion).toBe('stat_context_v2');
        // History demand is ~112 x the weekday factor; the forecast (incl. 5% buffer) must be in that neighbourhood.
        const weekday = new Date(`${TODAY}T00:00:00`).getDay();
        const expected = 112 * WEEKDAY[weekday] * 1.05;
        expect(f.predictedQuantity).toBeGreaterThan(expected * 0.75);
        expect(f.predictedQuantity).toBeLessThan(expected * 1.3);
        expect(f.confidenceScore).toBeGreaterThan(0.35);
        expect(f.keyFactors.expected_range.low).toBeLessThan(f.keyFactors.expected_range.high);
        expect(f.keyFactors.forecast_confidence.calibrated).toBe(false);
        expect(f.keyFactors.data_quality.stockout_days).toBeGreaterThanOrEqual(3);
        expect(f.keyFactors.demand_censoring.status).toBe('adjusted'); // sold-out days were recognised and corrected
        expect(f.keyFactors.leakage_guard.future_rows_excluded).toBe(0);
        const stored = await pool.query('SELECT predicted_quantity, model_version FROM ai_forecasts WHERE menu_item_id = $1 AND target_date = $2', [ctx.thali.id, TODAY]);
        expect(stored.rows).toHaveLength(1);
        expect(Number(stored.rows[0].predicted_quantity)).toBe(f.predictedQuantity);
        // A brand-new item falls back to the simple average instead of failing.
        const fresh = (await post('/api/menu-items', ctx.manager, { name: 'New Special', unit: 'servings' })).body.menuItem;
        const fallback = await get(`/api/forecasts/${fresh.id}?targetDate=${TODAY}`, ctx.manager);
        expect(fallback.body.data.modelVersion).toBe('heuristic_fallback_v1');
        step(5, 'Generate forecast', `stat_context_v2 predicted ${f.predictedQuantity} (range ${f.keyFactors.expected_range.low}-${f.keyFactors.expected_range.high}, confidence ${f.confidenceScore}); ${f.keyFactors.data_quality.stockout_days} sold-out days corrected; new item uses fallback`);
    });

    it('6. explains the cause of waste on the wasteful day, and reports no waste on a clean one', async () => {
        const wastefulDate = localDateString(-10);
        const res = await get(`/api/root-causes/${ctx.logIds[wastefulDate]}`, ctx.manager);
        expect(res.status).toBe(200);
        const rc = res.body.data;
        dump('6 rootcause wasteful', rc);
        expect(['low_attendance', 'over_preparation_vs_plan']).toContain(rc.cause);
        expect(rc.affectedItem).toBe(ctx.thali.id);
        expect(rc.estimatedContribution).toBeGreaterThan(0);
        expect(rc.confidenceScore).toBeGreaterThan(0);
        // Invariant across the whole history: a cause can never explain more waste than was left over.
        expect(rc.estimatedContribution).toBeLessThanOrEqual(120); // the wasteful day left 120
        for (const day of ctx.history) {
            const one = (await get(`/api/root-causes/${ctx.logIds[day.date]}`, ctx.manager)).body.data;
            expect(one.estimatedContribution).toBeGreaterThanOrEqual(0);
            expect(one.estimatedContribution).toBeLessThanOrEqual(day.leftover);
            expect(one.confidenceScore).toBeGreaterThanOrEqual(0);
            expect(one.confidenceScore).toBeLessThanOrEqual(1);
            if (day.leftover === 0) expect(one.cause).toBe('no_waste');
        }
        const soldOutDate = localDateString(-9);
        const clean = await get(`/api/root-causes/${ctx.logIds[soldOutDate]}`, ctx.manager);
        expect(clean.body.data.cause).toBe('no_waste');
        expect((await get(`/api/root-causes/${ctx.logIds[wastefulDate]}`, ctx.staff)).status).toBe(200);
        step(6, 'Root-cause analysis', `wasteful day -> ${rc.cause} (contribution ${rc.estimatedContribution}, confidence ${rc.confidenceScore}); sold-out day -> no_waste`);
    });

    it('7. evaluates the plan against the forecast (prevention)', async () => {
        const res = await post('/api/prevention/evaluate', ctx.staff, { menuItemId: ctx.thali.id, targetDate: TODAY, plannedQuantity: 150 });
        expect(res.status).toBe(200);
        const p = res.body.data;
        ctx.prevention = p;
        dump('7 prevention', p);
        expect(p.predictedQuantity).toBe(ctx.forecast.predictedQuantity); // same number the forecast endpoint gave
        expect(p.recommendedQuantity).toBe(p.predictedQuantity);
        expect(p.excess).toBeCloseTo(150 - p.predictedQuantity, 5);
        expect(p.riskLevel).toBe('HIGH');
        expect(p.plannedVsExpectedRange).toBe('above_range');
        expect(p.expectedRange).toMatchObject({ coverage: 0.8, basis: 'demand_before_safety_buffer' });
        expect(p.recommendationId).toBeGreaterThan(0);
        // A plan right at the forecast is low risk and creates no recommendation.
        const ok = await post('/api/prevention/evaluate', ctx.staff, { menuItemId: ctx.thali.id, targetDate: TODAY, plannedQuantity: ctx.forecast.predictedQuantity });
        expect(ok.body.data.riskLevel).toBe('LOW');
        expect(ok.body.data.recommendationId).toBeUndefined();
        step(7, 'Evaluate prevention', `planned 150 vs forecast ${p.predictedQuantity} -> HIGH risk, excess ${round1(p.excess)}, recommendation #${p.recommendationId}`);
    });

    it('8. the manager approves one recommendation and rejects another; staff cannot decide', async () => {
        const id = ctx.prevention.recommendationId;
        expect((await patch(`/api/prevention/${id}/status`, ctx.staff, { status: 'approved' })).status).toBe(403);
        expect((await patch(`/api/prevention/${id}/status`, ctx.manager, { status: 'maybe' })).status).toBe(400);
        const approved = await patch(`/api/prevention/${id}/status`, ctx.manager, { status: 'approved' });
        expect(approved.status).toBe(200);
        expect(approved.body.data.status).toBe('approved');
        const tomorrow = localDateString(1);
        const second = (await post('/api/prevention/evaluate', ctx.manager, { menuItemId: ctx.thali.id, targetDate: tomorrow, plannedQuantity: 190 })).body.data;
        const rejected = await patch(`/api/prevention/${second.recommendationId}/status`, ctx.manager, { status: 'rejected' });
        expect(rejected.body.data.status).toBe('rejected');
        const rows = (await pool.query('SELECT id, status FROM ai_prevention_recommendations ORDER BY id')).rows;
        expect(rows.map((r) => r.status)).toEqual(['approved', 'rejected']);
        step(8, 'Approve/reject recommendation', 'staff blocked (403), invalid status 400, one approved, one rejected, both persisted');
    });

    it('9. creates a surplus listing from a real daily log, with an advisory spoilage estimate', async () => {
        const preview = await post('/api/surplus-listings/spoilage-estimate', ctx.staff, { foodType: 'Rice and Dal', quantity: 12, preparedTime: future(-0.5), ambientTemperatureC: 30 });
        expect(preview.status).toBe(200);
        expect(preview.body.spoilageAssessment).toBeDefined();
        const res = await post('/api/surplus-listings', ctx.staff, {
            dailyLogId: ctx.logIds[YESTERDAY], quantity: 12, foodType: 'Rice and Dal', preparedTime: future(-0.5), ambientTemperatureC: 30,
        });
        expect(res.status).toBe(201);
        ctx.listing = res.body.listing;
        dump('9 listing', res.body);
        expect(ctx.listing).toMatchObject({ status: 'Available', kitchen_org_id: ctx.kitchenOrgId, daily_log_id: ctx.logIds[YESTERDAY] });
        expect(res.body.spoilageAssessment.safeUntilSource).toBe('estimated');
        expect(res.body.spoilageAssessment.appliedSafeUntil).toBeDefined();
        expect(new Date(ctx.listing.safe_until_time).getTime()).toBeGreaterThan(Date.now());
        expect((await get('/api/surplus-listings', ctx.manager)).body.listings.map((l) => l.id)).toContain(ctx.listing.id);
        step(9, 'Create surplus listing', `listing #${ctx.listing.id} (12 servings) linked to yesterday's log; ${res.body.spoilageAssessment.riskLevel} spoilage risk, safe until ${res.body.spoilageAssessment.appliedSafeUntil}`);
    });

    it('10. calculates rescue priority (system admin view; NGO view is checked after verification)', async () => {
        // The system admin account is bootstrapped with the real seed script, exactly as in a deployment.
        const adminEmail = uniqueEmail('sysadmin');
        const out = execFileSync(process.execPath, [path.join(__dirname, '../scripts/seedSystemAdmin.js')], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, SYSTEM_ADMIN_EMAIL: adminEmail, SYSTEM_ADMIN_PASSWORD: 'Adm1n-Passw0rd!', SYSTEM_ADMIN_NAME: 'Platform Admin' },
            encoding: 'utf8',
        });
        expect(out).toMatch(/Created system admin/);
        const login = await request(app).post('/api/auth/login').send({ email: adminEmail, password: 'Adm1n-Passw0rd!' });
        expect(login.status).toBe(200);
        expect(login.body.user.role).toBe('SYSTEM_ADMIN');
        adminToken = login.body.token;

        const res = await get('/api/rescue-priorities', adminToken);
        expect(res.status).toBe(200);
        const mine = res.body.data.find((l) => l.id === ctx.listing.id);
        expect(mine).toBeDefined();
        expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(mine.priorityLevel);
        expect(mine.priorityScore).toBeGreaterThan(0);
        expect(mine.supportingMetrics.time_remaining_mins).toBeGreaterThan(0);
        expect(mine).not.toHaveProperty('kitchen_latitude');
        expect((await get('/api/rescue-priorities', ctx.manager)).status).toBe(403); // kitchens never see other kitchens' surplus
        ctx.priority = mine;
        dump('10 rescue', mine);
        step(10, 'Calculate rescue priority', `${mine.priorityLevel} (score ${mine.priorityScore}, ${mine.supportingMetrics.time_remaining_mins} min left); admin seeded via scripts/seedSystemAdmin.js; kitchens blocked`);
    });

    it('11. registers NGOs (one near, one small and near, one far away, one unverified)', async () => {
        const register = async (name, geo, radius) => (await request(app).post('/api/auth/register-organization').send({
            organizationName: name, organizationType: 'ngo', pincode: '110002', ...geo, serviceRadiusKm: radius,
            name: `${name} Admin`, email: uniqueEmail('ngo'), password: 'Str0ng-Passw0rd!',
        })).body;
        ctx.ngoA = await register('Seva Food Bank', { latitude: 28.63, longitude: 77.22 }, 15);
        ctx.ngoB = await register('Small Shelter', { latitude: 28.58, longitude: 77.25 }, 15);
        ctx.ngoFar = await register('Chennai Food Rescue', { latitude: 13.0827, longitude: 80.2707 }, 5);
        ctx.ngoPending = await register('Unverified Trust', { latitude: 28.62, longitude: 77.21 }, 15);
        expect(ctx.ngoA.organization).toMatchObject({ type: 'ngo', verification_status: 'pending' });
        expect(ctx.ngoA.user.role).toBe('NGO_ADMIN');
        // Organizations describe how much and what they can take (used by matching).
        expect((await patch('/api/organizations/me', ctx.ngoA.token, { capacity_kg: 40, preferred_food_types: ['Rice and Dal'] })).status).toBe(200);
        expect((await patch('/api/organizations/me', ctx.ngoB.token, { capacity_kg: 3, preferred_food_types: ['Bakery'] })).status).toBe(200);
        // Until verified an NGO cannot use the feed, claim, or view rescue priorities.
        expect((await get('/api/surplus-listings/feed', ctx.ngoA.token)).status).toBe(403);
        expect((await post(`/api/surplus-listings/${ctx.listing.id}/claim`, ctx.ngoA.token, { proposedPickupTime: future(2) })).status).toBe(403);
        expect((await get('/api/rescue-priorities', ctx.ngoA.token)).status).toBe(403);
        step(11, 'Register NGO', '4 NGOs registered as pending (near, small, far, unverified); pending NGOs blocked from feed/claim/rescue view');
    });

    it('12. the system admin verifies NGOs, who are notified', async () => {
        const queue = await get('/api/organizations/pending-ngos', adminToken);
        expect(queue.body.organizations.map((o) => o.id)).toEqual(expect.arrayContaining([ctx.ngoA.organization.id, ctx.ngoPending.organization.id]));
        for (const n of [ctx.ngoA, ctx.ngoB, ctx.ngoFar]) {
            const res = await patch(`/api/organizations/${n.organization.id}/verify`, adminToken, { verificationStatus: 'verified' });
            expect(res.status).toBe(200);
            expect(res.body.organization.verification_status).toBe('verified');
        }
        const notified = await get('/api/notifications', ctx.ngoA.token);
        expect(notified.body.notifications.some((n) => n.type === 'NGO_VERIFICATION_RESULT' && /verified/.test(n.message))).toBe(true);
        expect((await patch(`/api/organizations/${ctx.ngoPending.organization.id}/verify`, ctx.manager, { verificationStatus: 'verified' })).status).toBe(403);
        const feed = await get('/api/surplus-listings/feed', ctx.ngoA.token);
        expect(feed.status).toBe(200);
        expect(feed.body.listings.map((l) => l.id)).toContain(ctx.listing.id);
        expect(feed.body.listings.find((l) => l.id === ctx.listing.id).distance_km).toBeGreaterThan(0);
        const far = await get('/api/surplus-listings/feed', ctx.ngoFar.token);
        expect(far.body.listings.map((l) => l.id)).not.toContain(ctx.listing.id); // outside its 5 km service area
        const rescue = await get('/api/rescue-priorities', ctx.ngoA.token); // now allowed for a verified NGO
        expect(rescue.status).toBe(200);
        expect(rescue.body.data.map((l) => l.id)).toContain(ctx.listing.id);
        expect((await get('/api/rescue-priorities', ctx.ngoFar.token)).body.data.map((l) => l.id)).not.toContain(ctx.listing.id);
        step(12, 'Admin verifies NGO', '3 NGOs verified + notified; unverified stays pending; near NGO sees the listing in its feed and rescue priorities, far NGO does not');
    });

    it('12b. a listing posted after verification notifies only the verified NGOs inside their service area', async () => {
        const second = await post('/api/surplus-listings', ctx.staff, { quantity: 20, foodType: 'Chapati', safeUntilTime: future(4) });
        expect(second.status).toBe(201);
        const notified = async (ngo) => (await get('/api/notifications', ngo.token)).body.notifications.filter((n) => n.type === 'SURPLUS_POSTED');
        expect((await notified(ctx.ngoA)).length).toBe(1);
        expect((await notified(ctx.ngoB)).length).toBe(1);
        expect((await notified(ctx.ngoA))[0].message).toMatch(/20 unit\(s\) of Chapati/);
        expect(await notified(ctx.ngoFar)).toHaveLength(0); // outside its 5 km area
        expect(await notified(ctx.ngoPending)).toHaveLength(0); // not verified
        // The kitchen withdraws nothing here; the second listing simply stays available and ranks in the feed by expiry.
        const feed = (await get('/api/surplus-listings/feed', ctx.ngoA.token)).body.listings;
        expect(feed.map((l) => l.id)).toEqual(expect.arrayContaining([ctx.listing.id, second.body.listing.id]));
        expect(feed.map((l) => l.safe_until_time)).toEqual(feed.map((l) => l.safe_until_time).slice().sort());
        step('12b', 'New listing notifies NGOs in range', 'both nearby verified NGOs notified; far and unverified NGOs not; feed ordered by expiry');
    });

    it('13. ranks NGO matches for the listing', async () => {
        const res = await get(`/api/surplus-listings/${ctx.listing.id}/ngo-matches`, ctx.manager);
        expect(res.status).toBe(200);
        const ids = res.body.matches.map((m) => m.ngoOrgId);
        expect(ids).toEqual([ctx.ngoA.organization.id, ctx.ngoB.organization.id]); // best fit first; far + unverified excluded
        const [best, small] = res.body.matches;
        expect(best.matchScore).toBeGreaterThan(small.matchScore);
        expect(best).toMatchObject({ matchMethod: 'scored' });
        expect(best.reason).toMatch(/km away/);
        expect(best.supportingMetrics).toMatchObject({ quantity: 12, food_type: 'Rice and Dal' });
        expect(best.supportingMetrics.category_score).toBeGreaterThan(small.supportingMetrics.category_score); // NGO A takes rice and dal
        expect(best.supportingMetrics.capacity_score).toBeGreaterThan(small.supportingMetrics.capacity_score); // NGO B is too small
        const persisted = await pool.query('SELECT COUNT(*)::int AS n FROM ai_ngo_match_scores WHERE surplus_listing_id = $1', [ctx.listing.id]);
        expect(persisted.rows[0].n).toBeGreaterThanOrEqual(2);
        expect((await get(`/api/surplus-listings/${ctx.listing.id}/ngo-matches`, ctx.ngoA.token)).status).toBe(403); // NGOs never see rival statistics
        ctx.matches = res.body.matches;
        dump('13 matches', res.body.matches);
        step(13, 'Generate NGO matches', `1) ${best.ngoName} ${best.matchScore} (${best.matchLevel}), 2) ${small.ngoName} ${small.matchScore} (${small.matchLevel}); far and unverified NGOs excluded; scores persisted`);
    });

    it('14. the best-matched NGO claims the surplus; first claim wins', async () => {
        const claim = await post(`/api/surplus-listings/${ctx.listing.id}/claim`, ctx.ngoA.token, { proposedPickupTime: future(1.5) });
        expect(claim.status).toBe(200);
        expect(claim.body.listing).toMatchObject({ status: 'Claimed', claimed_by_ngo_id: ctx.ngoA.organization.id });
        expect((await post(`/api/surplus-listings/${ctx.listing.id}/claim`, ctx.ngoB.token, { proposedPickupTime: future(1) })).status).toBe(409);
        const kitchenNotes = await get('/api/notifications?unreadOnly=true', ctx.manager);
        expect(kitchenNotes.body.notifications.some((n) => n.type === 'LISTING_CLAIMED')).toBe(true);
        expect((await get(`/api/surplus-listings/${ctx.listing.id}`, ctx.ngoA.token)).status).toBe(200); // the claimer may view it
        expect((await get(`/api/surplus-listings/${ctx.listing.id}`, ctx.ngoB.token)).status).toBe(403);
        const ngoView = await get(`/api/surplus-listings/${ctx.listing.id}/spoilage-assessment?ambientTemperatureC=28`, ctx.ngoA.token);
        expect(ngoView.status).toBe(200); // the claiming NGO can check the advisory spoilage estimate before pickup
        expect(ngoView.body.spoilageAssessment.riskLevel).toBeDefined();
        expect(JSON.stringify(ngoView.body)).toMatch(/not a guarantee/);
        expect((await get(`/api/surplus-listings/${ctx.listing.id}/spoilage-assessment`, ctx.ngoB.token)).status).toBe(403);
        expect((await get(`/api/surplus-listings/${ctx.listing.id}/ngo-matches`, ctx.manager)).status).toBe(409); // no longer Available
        step(14, 'NGO claims surplus', `${ctx.ngoA.organization.name} claimed, second NGO got 409, kitchen notified`);
    });

    it('15. the kitchen confirms the pickup time; the NGO is notified', async () => {
        const res = await patch(`/api/surplus-listings/${ctx.listing.id}/confirm-pickup`, ctx.manager, { confirmedPickupTime: future(1.75) });
        expect(res.status).toBe(200);
        expect(res.body.listing.confirmed_pickup_time).not.toBeNull();
        const ngoNotes = await get('/api/notifications', ctx.ngoA.token);
        expect(ngoNotes.body.notifications.some((n) => n.type === 'PICKUP_CONFIRMED')).toBe(true);
        expect((await patch(`/api/surplus-listings/${ctx.listing.id}/confirm-pickup`, ctx.ngoA.token, { confirmedPickupTime: future(2) })).status).toBe(403); // kitchen-only step
        step(15, 'Confirm pickup', 'pickup time set by the kitchen, NGO notified, NGO cannot confirm for the kitchen');
    });

    it('16. the NGO collects the surplus; a cap on the quantity protects the impact statistics', async () => {
        expect((await patch(`/api/surplus-listings/${ctx.listing.id}/collect`, ctx.ngoA.token, { quantityCollected: 500 })).status).toBe(400);
        const res = await patch(`/api/surplus-listings/${ctx.listing.id}/collect`, ctx.ngoA.token, { quantityCollected: 12 });
        expect(res.status).toBe(200);
        expect(res.body.listing.status).toBe('Collected');
        expect(res.body.listing.collected_at).not.toBeNull();
        const tx = await pool.query('SELECT quantity_collected FROM transactions_log WHERE surplus_listing_id = $1', [ctx.listing.id]);
        expect(tx.rows).toHaveLength(1);
        expect(tx.rows[0].quantity_collected).toBe(12);
        expect((await get('/api/notifications', ctx.manager)).body.notifications.some((n) => n.type === 'LISTING_COLLECTED')).toBe(true);
        expect((await get('/api/notifications', ctx.ngoA.token)).body.notifications.some((n) => n.type === 'LISTING_COLLECTED')).toBe(true);
        expect((await patch(`/api/surplus-listings/${ctx.listing.id}/collect`, ctx.ngoA.token, { quantityCollected: 12 })).status).toBe(409); // cannot collect twice
        step(16, 'Collect surplus', '12 servings collected, transaction logged, both sides notified, double collect 409, over-collection 400');
    });

    it('records the day\'s actual outcome: the kitchen followed the recommendation and left little over', async () => {
        const res = await post('/api/daily-logs', ctx.staff, {
            menuItemId: ctx.thali.id, logDate: TODAY, mealSlot: 'LUNCH', quantityPlanned: 150, quantityPrepared: 112, quantityConsumed: 106, quantityLeftover: 6, headcount: 118,
        });
        expect(res.status).toBe(201);
        ctx.todayLog = res.body.log;
        const rc = await get(`/api/root-causes/${ctx.todayLog.id}`, ctx.manager);
        expect(rc.status).toBe(200);
        expect(rc.body.data.affectedItem).toBe(ctx.thali.id);
        step('-', 'Record actual outcome (supports 23/24)', `today's log: prepared 112, consumed 106, leftover 6; root cause -> ${rc.body.data.cause}`);
    });

    it('17. and 18. financial and environmental impact match the logs', async () => {
        const res = await get('/api/financial-impact?period=monthly', ctx.manager);
        expect(res.status).toBe(200);
        const impact = res.body.data;
        ctx.impactBefore = impact;
        dump('17 impact', impact);
        // Independent calculation straight from the tables.
        const truth = (await pool.query(
            `SELECT COALESCE(SUM(dl.quantity_leftover * (mi.cost_per_unit + mi.preparation_cost_per_unit)), 0) AS loss,
                    COALESCE(SUM(dl.quantity_leftover), 0) AS leftover
             FROM daily_logs dl JOIN menu_items mi ON mi.id = dl.menu_item_id
             WHERE mi.kitchen_org_id = $1 AND dl.log_date >= CURRENT_DATE - INTERVAL '1 month' AND dl.quantity_leftover > 0`,
            [ctx.kitchenOrgId]
        )).rows[0];
        expect(impact.totalEstimatedLoss).toBeCloseTo(Number(truth.loss), 1);
        expect(impact.totalEstimatedLoss).toBeGreaterThan(0);
        expect(impact.breakdown.lossByItem['Veg Thali']).toBeGreaterThan(impact.breakdown.lossByItem.Chapati);
        expect(impact.breakdown.lossByDate[TODAY]).toBeCloseTo(6 * (COST.thali.cost + COST.thali.prep), 1);
        expect(impact.isEstimate).toBe(true);
        // Environmental: 2.5 kg CO2e and 1 meal per 0.4 kg of the same leftover food.
        expect(impact.environmentalImpact.estimatedCo2eKg).toBeCloseTo(Number(truth.leftover) * 2.5, 0);
        expect(impact.environmentalImpact.mealEquivalents).toBe(Math.floor(Number(truth.leftover) / 0.4));
        expect(impact.environmentalImpact.isEstimate).toBe(true);
        // The surplus the NGO collected in step 16 reaches the impact report (12 servings at 0.4 per meal, 2.5 kg CO2e each),
        // and is reported separately from the loss, which still counts every leftover.
        expect(impact.rescued).toMatchObject({ listingsCollected: 1, collectedQuantity: 12, mealEquivalents: 30, co2eAvoidedKg: 30, isEstimate: true });
        const saved = await pool.query('SELECT estimated_loss FROM ai_financial_impacts WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', [ctx.kitchenOrgId]);
        expect(Number(saved.rows[0].estimated_loss)).toBeCloseTo(impact.totalEstimatedLoss, 1);
        expect((await get('/api/financial-impact?period=weekly', ctx.staff)).status).toBe(200);
        expect((await get('/api/financial-impact?period=yearly', ctx.manager)).status).toBe(400);
        step('17/18', 'Financial + environmental impact', `monthly loss ${impact.totalEstimatedLoss} (matches SQL), ${impact.environmentalImpact.estimatedCo2eKg} kg CO2e of leftovers; rescued: ${impact.rescued.collectedQuantity} servings = ${impact.rescued.mealEquivalents} meals`);
    });

    it('19. the simulator compares plans without saving a forecast', async () => {
        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM ai_forecasts')).rows[0].n;
        const over = await post('/api/simulations/run', ctx.manager, { menuItemId: ctx.thali.id, targetDate: TODAY, proposedQuantity: 160 });
        const lean = await post('/api/simulations/run', ctx.manager, { menuItemId: ctx.thali.id, targetDate: TODAY, proposedQuantity: 90 });
        expect(over.status).toBe(200);
        expect(over.body.data.isEstimate).toBe(true);
        // Forecast for today now also sees today's log? No: only days BEFORE the target date are used.
        expect(over.body.data.predictedDemand).toBe(ctx.forecast.predictedQuantity);
        expect(over.body.data.estimatedSurplus).toBeCloseTo(160 - ctx.forecast.predictedQuantity, 5);
        expect(over.body.data.financialWaste).toBeCloseTo(over.body.data.estimatedSurplus * (COST.thali.cost + COST.thali.prep), 1);
        expect(over.body.data.environmentalImpact.co2eEmissionsKg).toBeGreaterThan(0);
        expect(lean.body.data.estimatedSurplus).toBe(0);
        expect(lean.body.data.estimatedShortageRisk).toBeGreaterThan(0);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM ai_forecasts')).rows[0].n).toBe(before);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM ai_simulations WHERE kitchen_org_id = $1', [ctx.kitchenOrgId])).rows[0].n).toBe(2);
        step(19, 'Simulator', `plan 160 -> surplus ${round1(over.body.data.estimatedSurplus)}, waste Rs ${over.body.data.financialWaste}; plan 90 -> shortage risk ${round1(lean.body.data.estimatedShortageRisk)}; no forecast rows written`);
    });

    it('20. logs a processing batch for a product', async () => {
        const product = await post('/api/processing/products', ctx.manager, { name: 'Wheat Flour Blend', unit: 'kg', item_type: 'finished_product', cost_per_unit: COST.product.cost, preparation_cost_per_unit: COST.product.prep });
        expect(product.status).toBe(201);
        ctx.product = product.body.data;
        expect((await post('/api/processing/products', ctx.staff, { name: 'Nope', unit: 'kg' })).status).toBe(403); // managers only
        const batch = await post('/api/processing/batches', ctx.staff, { product_id: ctx.product.id, log_date: YESTERDAY, input_quantity: 100, output_quantity: 88, rejects_quantity: 12, batch_number: 'B-2026-001' });
        expect(batch.status).toBe(201);
        expect(batch.body.data).toMatchObject({ meal_slot: 'BATCH', quantity_prepared: 100, quantity_leftover: 12, output_quantity: 88, batch_number: 'B-2026-001' });
        const batches = await get('/api/processing/batches', ctx.manager);
        expect(batches.body.data.map((b) => b.product_name)).toEqual(['Wheat Flour Blend']);
        expect((await post('/api/processing/batches', ctx.staff, { product_id: ctx.product.id, log_date: YESTERDAY, input_quantity: 50 })).status).toBe(400); // one batch per product per day
        step(20, 'Processing batch', 'input 100 kg -> output 88 kg + 12 kg rejects; duplicate batch/day refused; staff cannot create products');
    });

    it('21. processing waste shows up in the same analytics as kitchen waste', async () => {
        const after = (await get('/api/financial-impact?period=monthly', ctx.manager)).body.data;
        const rejectCost = 12 * (COST.product.cost + COST.product.prep);
        expect(after.totalEstimatedLoss - ctx.impactBefore.totalEstimatedLoss).toBeCloseTo(rejectCost, 1);
        expect(after.breakdown.lossByItem['Wheat Flour Blend']).toBeCloseTo(rejectCost, 1);
        expect(after.environmentalImpact.estimatedCo2eKg - ctx.impactBefore.environmentalImpact.estimatedCo2eKg).toBeCloseTo(12 * 2.5, 0);
        const attribution = (await get('/api/analytics/waste-attribution', ctx.manager)).body.data || (await get('/api/analytics/waste-attribution', ctx.manager)).body;
        const names = (attribution.byMenuItem || []).map((i) => i.name);
        expect(names).toContain('Wheat Flour Blend');
        expect((attribution.byMealSlot || []).map((s) => s.mealSlot)).toContain('BATCH');
        step(21, 'Processing waste in analytics', `rejects add Rs ${rejectCost} to financial loss and ${12 * 2.5} kg CO2e; product + BATCH slot appear in waste attribution`);
    });

    it('22. attributes waste to items, slots and weekdays consistently with the logs', async () => {
        const res = await get('/api/analytics/waste-attribution', ctx.manager);
        expect(res.status).toBe(200);
        const a = res.body.data || res.body;
        dump('22 attribution', a);
        const truth = (await pool.query(
            `SELECT mi.name, SUM(dl.quantity_leftover) AS waste, COUNT(*)::int AS logs
             FROM daily_logs dl JOIN menu_items mi ON mi.id = dl.menu_item_id WHERE mi.kitchen_org_id = $1 GROUP BY mi.name ORDER BY waste DESC`,
            [ctx.kitchenOrgId]
        )).rows;
        expect(a.totals.logCount).toBe(truth.reduce((s, r) => s + r.logs, 0));
        expect(a.totals.wasteQuantity).toBeCloseTo(truth.reduce((s, r) => s + Number(r.waste), 0), 1);
        const top = a.topMenuItems[0];
        expect(top.name).toBe(truth[0].name); // the biggest contributor by waste
        expect(top.wasteQuantity).toBeCloseTo(Number(truth[0].waste), 1);
        expect(a.meta.mixedUnits).toBe(true); // servings, pieces and kg are never silently added into one "unit"
        expect(a.insights.length).toBeGreaterThan(0);
        expect(a.byWeekday).toHaveLength(7);
        expect(JSON.stringify(a)).not.toMatch(/undefined|NaN/);
        step(22, 'Waste attribution', `${a.totals.logCount} logs, waste ${a.totals.wasteQuantity}; top item ${top.name} (${top.contributionPercentage}%); ${a.insights.length} insights; mixed units flagged`);
    });

    it('23. compares forecasts with what actually happened', async () => {
        const res = await get(`/api/analytics/forecast-performance?startDate=${localDateString(-HISTORY_DAYS)}&endDate=${TODAY}&menuItemId=${ctx.thali.id}`, ctx.manager);
        expect(res.status).toBe(200);
        const p = res.body.data;
        dump('23 performance', { summary: p.summary, trend: p.trend, interventions: p.interventions, today: p.records.find((r) => r.targetDate === TODAY), insights: p.insights });
        const today = p.records.find((r) => r.targetDate === TODAY);
        expect(today.status).toBe('evaluated');
        expect(today.forecast).toMatchObject({ source: 'stored', predictedQuantity: ctx.forecast.predictedQuantity, modelVersion: 'stat_context_v2' }); // the forecast from step 5, made before the outcome
        expect(today.actual).toMatchObject({ consumedQuantity: 106, preparedQuantity: 112, leftoverQuantity: 6, soldOut: false });
        expect(today.error.error).toBeCloseTo(ctx.forecast.predictedQuantity - 106, 1);
        expect(today.forecast.expectedRange.low).toBeLessThan(today.forecast.expectedRange.high);
        expect(p.summary.bySource.reconstructed.evaluatedCount).toBeGreaterThan(10); // earlier days, rebuilt from earlier logs only
        expect(p.summary.accuracyPercentage).toBeGreaterThan(50);
        expect(p.summary.reconstructedUsingLateLogs).toBeGreaterThan(0); // history was entered in bulk today: disclosed, not hidden
        expect(p.meta.historyAsOf.mode).toBe('log_date');
        const link = p.interventions.items.find((i) => i.targetDate === TODAY);
        expect(link).toMatchObject({ managerAction: 'approved', recommendedQuantity: ctx.prevention.predictedQuantity, forecast: { linked: true, predictedQuantity: ctx.forecast.predictedQuantity } });
        const strict = await get(`/api/analytics/forecast-performance?startDate=${TODAY}&endDate=${TODAY}&historyAsOf=recorded_at`, ctx.manager);
        expect(strict.status).toBe(200);
        step(23, 'Forecast-vs-actual', `today: predicted ${ctx.forecast.predictedQuantity} vs actual 106 (stored forecast, made before the outcome); ${p.summary.evaluatedCount} days evaluated, accuracy ${p.summary.accuracyPercentage}%; recommendation linked to its forecast; strict point-in-time mode available`);
    });

    it('24. evaluates whether the approved recommendation worked, and the result feeds back into the analytics', async () => {
        const res = await post('/api/learning/evaluate', ctx.manager, { targetDate: TODAY });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1); // only the approved recommendation with an actual log; the rejected one has none yet
        const outcome = res.body.data[0];
        dump('24 learning', res.body.data);
        expect(outcome).toMatchObject({ recommendationId: ctx.prevention.recommendationId, managerAction: 'approved' });
        // Original plan 150 cut to 112 (38 avoided), 6 still left over: 38 / 44.
        expect(outcome.effectivenessScore).toBeCloseTo(38 / 44, 2);
        const stored = await pool.query('SELECT effectiveness_score, manager_action FROM ai_interventions WHERE recommendation_id = $1', [ctx.prevention.recommendationId]);
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0].manager_action).toBe('approved');
        const perf = (await get(`/api/analytics/forecast-performance?startDate=${TODAY}&endDate=${TODAY}`, ctx.manager)).body.data;
        const item = perf.interventions.items.find((i) => i.recommendationId === ctx.prevention.recommendationId);
        expect(item.outcome.evaluated).toBe(true);
        expect(item.outcome.effectivenessScore).toBeCloseTo(0.86, 1);
        expect(perf.interventions.summary.evaluatedCount).toBe(1);
        step(24, 'Learning evaluation', `approved recommendation scored ${outcome.effectivenessScore.toFixed(2)} (38 of 44 units of avoidable waste avoided); persisted and visible in forecast-vs-actual`);
    });

    it('25. an event on the target date changes the forecast, explained, and removing it restores the baseline', async () => {
        const day = localDateString(14);
        const baseline = (await get(`/api/forecasts/${ctx.thali.id}?targetDate=${day}`, ctx.manager)).body.data;
        expect(baseline.keyFactors.event_context).toBeUndefined();
        expect((await post('/api/events', ctx.staff, { eventDate: day, eventType: 'special_meal', name: 'Founders Day feast' })).status).toBe(403); // managers only
        const created = await post('/api/events', ctx.manager, { eventDate: day, eventType: 'special_meal', name: 'Founders Day feast', expectedImpactPct: 40 });
        expect(created.status).toBe(201);
        const boosted = (await get(`/api/forecasts/${ctx.thali.id}?targetDate=${day}`, ctx.manager)).body.data;
        expect(boosted.predictedQuantity).toBeCloseTo(baseline.predictedQuantity * 1.4, 0);
        expect(boosted.keyFactors.event_context.target_events[0]).toMatchObject({ type: 'special_meal', name: 'Founders Day feast', expected_impact_pct: 40 });
        expect(boosted.keyFactors.event_context.adjustment).toMatchObject({ evidence: 'declared', factor: 1.4 });
        expect(boosted.keyFactors.reason).toMatch(/Founders Day feast/);
        expect(boosted.confidenceScore).toBeLessThanOrEqual(baseline.confidenceScore);
        const closure = await post('/api/events', ctx.manager, { eventDate: localDateString(15), eventType: 'closure', name: 'Kitchen closed', expectedImpactPct: -100 });
        expect(closure.status).toBe(201);
        expect((await get(`/api/forecasts/${ctx.thali.id}?targetDate=${localDateString(15)}`, ctx.manager)).body.data.predictedQuantity).toBe(0);
        // Another organization's events never affect this kitchen (checked with a second kitchen with the same history).
        expect((await del(`/api/events/${created.body.event.id}`, ctx.manager)).status).toBe(200);
        const restored = (await get(`/api/forecasts/${ctx.thali.id}?targetDate=${day}`, ctx.manager)).body.data;
        expect(restored.predictedQuantity).toBe(baseline.predictedQuantity);
        expect(restored.keyFactors.event_context).toBeUndefined();
        step(25, 'Event-aware forecast', `special meal +40% -> ${baseline.predictedQuantity} to ${boosted.predictedQuantity} (evidence: declared); closure -> 0; delete restores baseline`);
    });

    // The dashboard (frontend/src/dashboard) reads only these endpoints. This step makes the same requests it makes,
    // as each role, and checks the fields its cards read exist, so a card can never silently show nothing.
    it('26. serves every data source the dashboard uses, to the right roles, with the fields it reads', async () => {
        const iso = (offset) => localDateString(offset);
        const forecastsBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM ai_forecasts')).rows[0].n;
        const dash = {};

        for (const [who, token] of [['manager', ctx.manager], ['staff', ctx.staff]]) {
            const menu = await get('/api/menu-items', token);
            expect(menu.status).toBe(200);
            expect(menu.body.menuItems[0]).toEqual(expect.objectContaining({ id: expect.any(Number), name: expect.any(String), unit: expect.any(String), cost_per_unit: expect.any(Number), preparation_cost_per_unit: expect.any(Number) }));

            const forecast = await get(`/api/forecasts/${ctx.thali.id}?targetDate=${TODAY}&persist=false`, token);
            expect(forecast.status).toBe(200);
            const kf = forecast.body.data.keyFactors;
            expect(forecast.body.data).toEqual(expect.objectContaining({ predictedQuantity: expect.any(Number), confidenceScore: expect.any(Number), modelVersion: expect.any(String) }));
            expect(kf.expected_range).toEqual(expect.objectContaining({ low: expect.any(Number), high: expect.any(Number), coverage: expect.any(Number) }));
            expect(kf.safety_buffer).toEqual(expect.any(String));
            const fallback = await get(`/api/forecasts/${(await get('/api/menu-items', token)).body.menuItems.find((m) => m.name === 'New Special').id}?targetDate=${TODAY}&persist=false`, token);
            expect(fallback.body.data.keyFactors.minimum_observations).toEqual(expect.any(Number)); // the fallback badge reads this

            const waste = await get(`/api/analytics/waste-attribution?startDate=${iso(-7)}&endDate=${TODAY}`, token);
            expect(waste.status).toBe(200);
            const w = waste.body.data;
            expect(w.totals).toEqual(expect.objectContaining({ logCount: expect.any(Number), preparedQuantity: expect.any(Number), wasteQuantity: expect.any(Number) }));
            expect(Array.isArray(w.topMenuItems) && Array.isArray(w.insights) && Array.isArray(w.patterns.recurringOverPreparation)).toBe(true);
            expect(w.meta).toEqual(expect.objectContaining({ mixedUnits: expect.any(Boolean), units: expect.any(Array) }));
            const previous = await get(`/api/analytics/waste-attribution?startDate=${iso(-15)}&endDate=${iso(-8)}`, token);
            expect(previous.status).toBe(200);

            const impact = await get('/api/financial-impact?period=weekly', token);
            expect(impact.status).toBe(200);
            expect(impact.body.data).toEqual(expect.objectContaining({ totalEstimatedLoss: expect.any(Number) }));
            expect(impact.body.data.environmentalImpact).toEqual(expect.objectContaining({ estimatedCo2eKg: expect.any(Number), mealEquivalents: expect.any(Number) }));
            expect(impact.body.data.rescued).toEqual(expect.objectContaining({ listingsCollected: expect.any(Number), collectedQuantity: expect.any(Number), mealEquivalents: expect.any(Number), co2eAvoidedKg: expect.any(Number) }));

            const perf = await get('/api/analytics/forecast-performance', token);
            expect(perf.status).toBe(200);
            const p = perf.body.data;
            expect(p.summary).toEqual(expect.objectContaining({ evaluatedCount: expect.any(Number) }));
            expect(p.summary.bySource.stored.evaluatedCount).toEqual(expect.any(Number));
            expect(p.summary.bySource.reconstructed.evaluatedCount).toEqual(expect.any(Number));
            expect(p.trend.direction).toEqual(expect.any(String));
            expect(p.period).toEqual(expect.objectContaining({ startDate: expect.any(String), endDate: expect.any(String) }));
            const approved = p.interventions.items.find((i) => i.managerAction === 'approved');
            expect(approved).toEqual(expect.objectContaining({ menuItemId: ctx.thali.id, originalPlannedQuantity: expect.any(Number), actual: expect.objectContaining({ preparedQuantity: 112 }) }));

            const listings = await get('/api/surplus-listings?limit=200', token);
            expect(listings.status).toBe(200);
            expect(listings.body.listings[0]).toEqual(expect.objectContaining({ id: expect.any(Number), status: expect.any(String), quantity: expect.any(Number), food_type: expect.any(String), safe_until_time: expect.anything(), created_at: expect.anything() }));
            const claimed = listings.body.listings.find((l) => l.claimed_by_ngo_id);
            expect(claimed).toEqual(expect.objectContaining({ claimed_by_ngo_id: ctx.ngoA.organization.id, status: 'Collected' }));
            const open = listings.body.listings.find((l) => l.status === 'Available');
            const spoilage = await get(`/api/surplus-listings/${open.id}/spoilage-assessment`, token);
            expect(spoilage.status).toBe(200);
            expect(spoilage.body.spoilageAssessment).toEqual(expect.objectContaining({ riskLevel: expect.stringMatching(/^(LOW|MEDIUM|HIGH|EXPIRED)$/), minutesRemaining: expect.any(Number) }));

            const ngos = await get('/api/organizations?type=ngo&limit=100', token);
            expect(ngos.status).toBe(200);
            expect(ngos.body.organizations.map((o) => o.id)).toContain(ctx.ngoA.organization.id);
            expect(ngos.body.organizations.map((o) => o.id)).not.toContain(ctx.ngoPending.organization.id); // only verified NGOs are listed

            if (who === 'manager') Object.assign(dash, { menu: menu.body.menuItems, forecast: forecast.body.data, waste: w, previous: previous.body.data, impact: impact.body.data, perf: p, listings: listings.body.listings, ngos: ngos.body.organizations, spoilage: spoilage.body.spoilageAssessment });
        }
        // Previews save nothing: the dashboard can refresh as often as it likes without touching forecast-vs-actual.
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM ai_forecasts')).rows[0].n).toBe(forecastsBefore);

        // NGO role: feed, rescue priority, notifications. A pending NGO can read notifications but not the feed.
        const feed = await get('/api/surplus-listings/feed', ctx.ngoA.token);
        expect(feed.status).toBe(200);
        expect(feed.body.listings[0]).toEqual(expect.objectContaining({ quantity: expect.any(Number), safe_until_time: expect.anything() }));
        expect(feed.body.listings.some((l) => typeof l.distance_km === 'number')).toBe(true);
        const priorities = await get('/api/rescue-priorities', ctx.ngoA.token);
        expect(priorities.body.data[0]).toEqual(expect.objectContaining({ priorityLevel: expect.any(String), reason: expect.any(String), quantity: expect.any(Number) }));
        const ngoNotes = await get('/api/notifications?limit=100', ctx.ngoA.token);
        expect(ngoNotes.status).toBe(200);
        expect(ngoNotes.body.notifications[0]).toEqual(expect.objectContaining({ type: expect.any(String), is_read: expect.any(Boolean) }));
        expect((await get('/api/notifications?limit=100', ctx.ngoPending.token)).status).toBe(200);
        expect((await get('/api/surplus-listings/feed', ctx.ngoPending.token)).status).toBe(403);
        expect((await get('/api/auth/me', ctx.ngoA.token)).body.organization.verification_status).toBe('verified'); // the NGO dashboard reads this

        // Admin role.
        const pending = await get('/api/organizations/pending-ngos?limit=100', adminToken);
        expect(pending.body.organizations.map((o) => o.name)).toContain('Unverified Trust');
        expect(pending.body.organizations[0]).toEqual(expect.objectContaining({ name: expect.any(String), created_at: expect.anything() }));
        const everyone = await get('/api/organizations?limit=200', adminToken);
        expect(everyone.body.organizations.some((o) => o.type === 'kitchen') && everyone.body.organizations.some((o) => o.type === 'ngo')).toBe(true);
        expect((await get('/api/rescue-priorities', adminToken)).status).toBe(200);

        dump('26 dashboard', { ...dash, feed: feed.body.listings, priorities: priorities.body.data, notifications: ngoNotes.body.notifications, pending: pending.body.organizations, organizations: everyone.body.organizations });
        step(26, 'Dashboard data sources', 'every request the dashboard makes works for kitchen manager + staff, verified/pending NGO and admin; previews store nothing');
    });
});

// ---------------------------------------------------------------------------
// The same server, started as a real process (what `npm start` runs), driven over HTTP
// ---------------------------------------------------------------------------

describe('E2E: the real server process', () => {
    let server;
    let baseUrl;

    beforeAll(async () => {
        const port = 5900 + Math.floor(Math.random() * 90);
        baseUrl = `http://127.0.0.1:${port}`;
        const env = { ...process.env, PORT: String(port) };
        delete env.NODE_ENV; // start exactly as in development/production: full env validation runs
        server = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', () => {});
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
            server.stdout.on('data', (chunk) => {
                if (String(chunk).includes('Server is running')) {
                    clearTimeout(timer);
                    resolve();
                }
            });
            server.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
        });
    }, 30000);

    afterAll(() => {
        if (server) server.kill();
    });

    it('serves health, registration, login, authenticated CRUD and rejects bad requests over real HTTP', async () => {
        const json = async (method, url, { token, body } = {}) => {
            const res = await fetch(`${baseUrl}${url}`, {
                method,
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: body ? JSON.stringify(body) : undefined,
            });
            return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
        };
        expect((await json('GET', '/api/health')).body).toEqual({ status: 'ok', database: 'connected' });
        const email = uniqueEmail('httpkitchen');
        const registered = await json('POST', '/api/auth/register-organization', { body: { organizationName: 'HTTP Kitchen', organizationType: 'kitchen', pincode: '1', name: 'Http User', email, password: 'Str0ng-Passw0rd!' } });
        expect(registered.status).toBe(201);
        const login = await json('POST', '/api/auth/login', { body: { email, password: 'Str0ng-Passw0rd!' } });
        expect(login.status).toBe(200);
        const token = login.body.token;
        const item = await json('POST', '/api/menu-items', { token, body: { name: 'HTTP Rice', unit: 'kg' } });
        expect(item.status).toBe(201);
        const log = await json('POST', '/api/daily-logs', { token, body: { menuItemId: item.body.menuItem.id, logDate: TODAY, mealSlot: 'LUNCH', quantityPrepared: 10, quantityLeftover: 2 } });
        expect(log.status).toBe(201);
        const forecast = await json('GET', `/api/forecasts/${item.body.menuItem.id}?targetDate=${localDateString(1)}`, { token });
        expect(forecast.status).toBe(200);
        expect(forecast.body.data.modelVersion).toBe('heuristic_fallback_v1'); // one day of history
        expect((await json('GET', '/api/menu-items')).status).toBe(401);
        expect((await json('GET', '/api/nope', { token })).status).toBe(404);
        expect(item.headers.get('x-powered-by')).toBeNull();
        expect(item.headers.get('cache-control')).toBe('no-store');
    }, 30000);
});
