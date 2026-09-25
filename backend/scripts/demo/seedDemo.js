'use strict';

/**
 * Deterministic demo dataset for the SIH presentation.
 *
 * Walks the whole product loop through the REAL HTTP API (via supertest against the Express app in-process — the
 * same app.js a live server runs, just without binding a port), exactly as a kitchen, NGOs and an admin would use
 * it. Nothing here talks to a model or a table directly except the one place a system admin account has to be
 * bootstrapped (there is no public "become admin" endpoint) and the final self-check, which reads back what the
 * API itself returned.
 *
 * "Deterministic" here means: the STRUCTURE of the data (which days are sold out, which are over-prepared, the
 * relative demand shape, the exact scripted actions) is fixed and reproduces the same story every run. The DATES
 * are always relative to the day the script is run (today, today-1, today+7, ...), because the platform's leakage
 * rules are date-relative by design (see forecastEngine.js) — a fixed absolute date would go stale and eventually
 * stop demonstrating anything. See scripts/demo/README.md.
 *
 * Safety:
 *   - Never runs automatically: only `npm run demo:seed` / `node scripts/demo/seedDemo.js` invoke it. Server
 *     startup (src/index.js) and migrations (scripts/migrate.js) never call this file.
 *   - Refuses to run if demo data already exists (points at `npm run demo:reset` instead of guessing).
 *   - Everything it creates is a brand-new organization/user, isolated by the platform's own authorization and
 *     organization-scoping rules (the same ones every other tenant relies on) — this script grants itself no
 *     special access.
 */

const path = require('path');
const request = require('supertest');
const bcrypt = require('bcrypt');

const app = require('../../src/app');
const pool = require('../../src/models/db');
const env = require('../../src/config/env');
const userModel = require('../../src/models/userModel');
const { DEMO_ORG_PREFIX, DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, DEMO_ADMIN_EMAIL } = require('./constants');
const { assertNotProduction } = require('./productionGuard');

// ---------------------------------------------------------------------------------------------------------------
// Small helpers (deliberately self-contained: this script does not depend on anything under tests/)
// ---------------------------------------------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(20260921); // fixed seed: the noise pattern is identical on every run

function localDateString(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
const weekdayOf = (offsetDays) => new Date(`${localDateString(offsetDays)}T00:00:00`).getDay(); // 0 = Sunday
const round1 = (v) => Math.round(v * 10) / 10;
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

function assert(condition, message) {
    if (!condition) throw new Error(`Self-check failed: ${message}`);
}

const log = (...args) => console.log(...args);
const section = (title) => console.log(`\n=== ${title} ===`);

// ---------------------------------------------------------------------------------------------------------------
// Thin HTTP client (real routes, real validation, real RBAC — nothing here bypasses the app)
// ---------------------------------------------------------------------------------------------------------------

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function api(method, url, { token, body, expect = [200, 201, 204] } = {}) {
    let req = request(app)[method](url);
    if (token) req = req.set(auth(token));
    const res = body !== undefined ? await req.send(body) : await req;
    const allowed = Array.isArray(expect) ? expect : [expect];
    if (!allowed.includes(res.status)) {
        throw new Error(`${method.toUpperCase()} ${url} -> ${res.status} (expected ${allowed.join('/')}): ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    return res.body;
}
const get = (url, token, opts) => api('get', url, { token, ...opts });
const post = (url, token, body, opts) => api('post', url, { token, body, ...opts });
const patch = (url, token, body, opts) => api('patch', url, { token, body, ...opts });
const del = (url, token, opts) => api('delete', url, { token, ...opts });

// ---------------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------------

async function registerOrganization({ name, type, pincode, latitude, longitude, adminName, email }) {
    const body = await post('/api/auth/register-organization', null, {
        organizationName: `${DEMO_ORG_PREFIX}${name}`, organizationType: type, pincode, latitude, longitude,
        name: adminName, email, password: DEMO_PASSWORD,
    }, { expect: 201 });
    return { token: body.token, user: body.user, organization: body.organization };
}

async function createSubUser(managerToken, { name, email, role }) {
    await post('/api/auth/users', managerToken, { name, email, password: DEMO_PASSWORD, role }, { expect: 201 });
    const login = await post('/api/auth/login', null, { email, password: DEMO_PASSWORD }, { expect: 200 });
    return login.token;
}

// A system admin is needed to verify NGOs. Reuse one from the environment if it works; otherwise bootstrap a
// dedicated, clearly-marked demo admin (there is no public endpoint for this — the seed script for a real deploy,
// scripts/seedSystemAdmin.js, has exactly the same limitation).
async function ensureSystemAdmin() {
    const envEmail = process.env.SYSTEM_ADMIN_EMAIL;
    const envPassword = process.env.SYSTEM_ADMIN_PASSWORD;
    if (envEmail && envPassword) {
        const res = await request(app).post('/api/auth/login').send({ email: envEmail, password: envPassword });
        if (res.status === 200 && res.body.user.role === 'SYSTEM_ADMIN') {
            log(`Using the existing system admin account (${envEmail}) from SYSTEM_ADMIN_EMAIL to verify demo NGOs.`);
            return { token: res.body.token, email: envEmail, isDemoAccount: false };
        }
    }
    const existing = await userModel.findByEmail(DEMO_ADMIN_EMAIL);
    if (!existing) {
        const passwordHash = await bcrypt.hash(DEMO_PASSWORD, env.bcryptSaltRounds);
        await userModel.create({ name: 'Demo Platform Admin', email: DEMO_ADMIN_EMAIL, passwordHash, role: 'SYSTEM_ADMIN', organizationId: null });
        log(`Created a demo system admin account: ${DEMO_ADMIN_EMAIL} / ${DEMO_PASSWORD}`);
    } else {
        log(`Reusing the demo system admin account from a previous partial run: ${DEMO_ADMIN_EMAIL}`);
    }
    const login = await request(app).post('/api/auth/login').send({ email: DEMO_ADMIN_EMAIL, password: DEMO_PASSWORD });
    return { token: login.body.token, email: DEMO_ADMIN_EMAIL, isDemoAccount: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario data: 36 days of history (today-35 .. today) for the "hero" item, built to exercise every signal.
// ---------------------------------------------------------------------------------------------------------------

const HISTORY_DAYS = 35; // offsets -35 .. -1, plus today (0) = 36 daily logs
const WEEKDAY_MULT = [0.7, 1.15, 1.1, 1.0, 1.0, 1.05, 0.85]; // Sun..Sat: weekday demand variation
const THALI_BASE = 130;
const THALI_PER_PERSON = 0.9;
const SOLD_OUT_OFFSETS = new Set([-32, -24, -16]); // under-supply: sold out before everyone was served
const DRAMATIC_OFFSET = -10; // the one-off incident the root-cause narrative is built on
const OVER_PREPARED_OFFSETS = new Set([-4, -3, -2]); // repeated over-preparation, inside the "last 5 logs" window

function vegThaliDemand(offset) {
    const wd = weekdayOf(offset);
    return Math.round(THALI_BASE * WEEKDAY_MULT[wd] * (1 + (rng() - 0.5) * 0.1));
}

// One realistic daily_logs-shaped row per day. `type` is only for the console narrative.
function buildVegThaliHistory() {
    const rows = [];
    for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
        const demand = vegThaliDemand(offset);
        const perPerson = THALI_PER_PERSON * (1 + (rng() - 0.5) * 0.06);
        const headcount = Math.round(demand / perPerson);

        let row;
        if (offset === DRAMATIC_OFFSET) {
            // A manager over-planned for an event that fell through: only 58 of the usual ~130+ attendees came.
            row = { quantityPlanned: 150, quantityPrepared: 232, headcount: 58, quantityConsumed: 101, quantityLeftover: 131, type: 'dramatic (low attendance)' };
        } else if (SOLD_OUT_OFFSETS.has(offset)) {
            const prepared = Math.round(demand * 0.9); // under-supplied: everyone who got served finished it
            row = { quantityPlanned: prepared, quantityPrepared: prepared, headcount, quantityConsumed: prepared, quantityLeftover: 0, type: 'sold out' };
        } else if (OVER_PREPARED_OFFSETS.has(offset)) {
            const prepared = Math.round(demand * 1.35);
            row = { quantityPlanned: Math.round(prepared * 0.95), quantityPrepared: prepared, headcount, quantityConsumed: demand, quantityLeftover: prepared - demand, type: 'over-prepared' };
        } else if (offset === 0) {
            // Today: the manager followed the AI's recommendation instead of the original inflated plan.
            row = { quantityPlanned: null, quantityPrepared: null, headcount, quantityConsumed: null, quantityLeftover: null, type: 'today (pending: set after the forecast/recommendation exist)' };
        } else {
            const prepared = Math.round(demand * (1.08 + rng() * 0.05));
            row = { quantityPlanned: Math.round(prepared * 0.98), quantityPrepared: prepared, headcount, quantityConsumed: demand, quantityLeftover: prepared - demand, type: 'normal' };
        }
        rows.push({ offset, date: localDateString(offset), ...row });
    }
    return rows;
}

function buildChapatiHistory() {
    const rows = [];
    for (let offset = -HISTORY_DAYS + 1; offset <= 0; offset += 1) {
        const wd = weekdayOf(offset);
        for (const [slot, base] of [['LUNCH', 140], ['DINNER', 100]]) {
            const demand = Math.round(base * WEEKDAY_MULT[wd] * (1 + (rng() - 0.5) * 0.08));
            const prepared = Math.round(demand * (1.03 + rng() * 0.03)); // a well-managed item: kept well under Veg Thali's waste
            rows.push({
                offset, date: localDateString(offset), mealSlot: slot,
                quantityPlanned: Math.round(prepared * 0.98), quantityPrepared: prepared, quantityConsumed: demand, quantityLeftover: prepared - demand,
            });
        }
    }
    return rows;
}

// A second, unrelated kitchen: proves the platform's own organization scoping (nothing here feeds Kitchen A's
// numbers), without duplicating the full pipeline.
function buildKitchenBHistory() {
    const rows = [];
    for (let offset = -6; offset <= 0; offset += 1) {
        const demand = Math.round(60 * (1 + (rng() - 0.5) * 0.1));
        const prepared = Math.round(demand * 1.1);
        rows.push({ offset, date: localDateString(offset), quantityPlanned: prepared, quantityPrepared: prepared, quantityConsumed: demand, quantityLeftover: prepared - demand });
    }
    return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

async function alreadySeeded() {
    const { rows } = await pool.query('SELECT id FROM organizations WHERE name LIKE $1 LIMIT 1', [`${DEMO_ORG_PREFIX}%`]);
    return rows.length > 0;
}

async function seedDemoData() {
    // Checked first, before any database access, so a misconfigured NODE_ENV can never result in demo data - or
    // the demo admin credentials - reaching a live deployment.
    assertNotProduction();
    if (await alreadySeeded()) {
        throw new Error(
            'Demo data already exists (an organization named "[DEMO] ..." was found). ' +
                'Run `npm run demo:reset` first, then seed again.'
        );
    }

    const credentials = [];
    const rememberLogin = (roleLabel, email) => credentials.push({ role: roleLabel, email, password: DEMO_PASSWORD });

    // ---- organizations & users --------------------------------------------------------------------------------
    section('Registering organizations');
    const kitchenA = await registerOrganization({
        name: 'Anna Sewa Community Kitchen', type: 'kitchen', pincode: '560001', latitude: 12.9716, longitude: 77.5946,
        adminName: 'Lakshmi Iyer', email: `kitchen.manager@${DEMO_EMAIL_DOMAIN}`,
    });
    rememberLogin('Kitchen manager (Kitchen A — the full scenario)', kitchenA.user.email);
    const staffToken = await createSubUser(kitchenA.token, { name: 'Arjun Mehta', email: `kitchen.staff@${DEMO_EMAIL_DOMAIN}`, role: 'KITCHEN_STAFF' });
    rememberLogin('Kitchen staff (Kitchen A)', `kitchen.staff@${DEMO_EMAIL_DOMAIN}`);

    const kitchenB = await registerOrganization({
        name: 'Ganga Prasad Kitchen', type: 'kitchen', pincode: '600001', latitude: 13.0827, longitude: 80.2707,
        adminName: 'Devika Rao', email: `kitchen2.manager@${DEMO_EMAIL_DOMAIN}`,
    });
    rememberLogin('Kitchen manager (Kitchen B — isolation control, unrelated to Kitchen A)', kitchenB.user.email);

    const ngoStrong = await registerOrganization({
        name: 'Seva Rescue Foundation', type: 'ngo', pincode: '560002', latitude: 12.9791, longitude: 77.5913,
        adminName: 'Farah Sheikh', email: `ngo.seva@${DEMO_EMAIL_DOMAIN}`,
    });
    rememberLogin('NGO admin (verified, strong match — completes a rescue)', ngoStrong.user.email);
    const ngoWeak = await registerOrganization({
        name: 'Small Care Shelter', type: 'ngo', pincode: '560090', latitude: 12.85, longitude: 77.5,
        adminName: 'Imran Qureshi', email: `ngo.smallcare@${DEMO_EMAIL_DOMAIN}`,
    });
    rememberLogin('NGO admin (verified, weaker match — for ranking contrast)', ngoWeak.user.email);
    const ngoPending = await registerOrganization({
        name: 'New Hope Trust', type: 'ngo', pincode: '560010', latitude: 12.97, longitude: 77.6,
        adminName: 'Priya Nair', email: `ngo.newhope@${DEMO_EMAIL_DOMAIN}`,
    });
    rememberLogin('NGO admin (left PENDING on purpose — verify it live)', ngoPending.user.email);

    const admin = await ensureSystemAdmin();
    if (admin.isDemoAccount) rememberLogin('System admin (demo account)', admin.email);
    else log(`(System admin login: use your own SYSTEM_ADMIN_EMAIL/PASSWORD — ${admin.email})`);

    await patch('/api/organizations/me', ngoStrong.token, { capacity_kg: 60 }, { expect: 200 });
    await patch('/api/organizations/me', ngoWeak.token, { capacity_kg: 2, preferred_food_types: ['Bakery Items', 'Fruit and Juice'] }, { expect: 200 });
    await patch(`/api/organizations/${ngoStrong.organization.id}/verify`, admin.token, { verificationStatus: 'verified' }, { expect: 200 });
    await patch(`/api/organizations/${ngoWeak.organization.id}/verify`, admin.token, { verificationStatus: 'verified' }, { expect: 200 });
    log('Verified: Seva Rescue Foundation, Small Care Shelter. Left pending: New Hope Trust.');

    // ---- menu items --------------------------------------------------------------------------------------------
    section('Menu items');
    const thali = await post('/api/menu-items', kitchenA.token, { name: 'Veg Thali', unit: 'servings', costPerUnit: 45, preparationCostPerUnit: 8 }, { expect: 201 });
    const chapati = await post('/api/menu-items', kitchenA.token, { name: 'Chapati', unit: 'pieces', costPerUnit: 3, preparationCostPerUnit: 1 }, { expect: 201 });
    const flour = await post('/api/processing/products', kitchenA.token, { name: 'Milled Rice Flour', unit: 'kg', item_type: 'raw_material', cost_per_unit: 28, preparation_cost_per_unit: 4 }, { expect: 201 });
    const kitchenBItem = await post('/api/menu-items', kitchenB.token, { name: 'Sambar Rice', unit: 'servings', costPerUnit: 30, preparationCostPerUnit: 6 }, { expect: 201 });
    log(`Kitchen A: Veg Thali (id ${thali.menuItem.id}), Chapati (id ${chapati.menuItem.id}), processing product Milled Rice Flour (id ${flour.data.id}).`);
    log(`Kitchen B: Sambar Rice (id ${kitchenBItem.menuItem.id}) — its own, unrelated organization.`);

    // ---- history -------------------------------------------------------------------------------------------
    section(`Daily logs (${HISTORY_DAYS + 1} days of history per item)`);
    const thaliHistory = buildVegThaliHistory();
    const thaliLogIds = {};
    for (const day of thaliHistory) {
        if (day.offset === 0) continue; // today's Veg Thali log is written after the forecast/recommendation exist
        const created = await post('/api/daily-logs', staffToken, {
            menuItemId: thali.menuItem.id, logDate: day.date, mealSlot: 'LUNCH', quantityPlanned: day.quantityPlanned,
            quantityPrepared: day.quantityPrepared, headcount: day.headcount, quantityConsumed: day.quantityConsumed, quantityLeftover: day.quantityLeftover,
        }, { expect: 201 });
        thaliLogIds[day.offset] = created.log.id;
    }
    process.stdout.write(`  Veg Thali: ${Object.keys(thaliLogIds).length} logs written (sold out x${SOLD_OUT_OFFSETS.size}, 1 dramatic incident, over-prepared x${OVER_PREPARED_OFFSETS.size}).\n`);

    const chapatiHistory = buildChapatiHistory();
    for (const day of chapatiHistory) {
        await post('/api/daily-logs', staffToken, {
            menuItemId: chapati.menuItem.id, logDate: day.date, mealSlot: day.mealSlot, quantityPlanned: day.quantityPlanned,
            quantityPrepared: day.quantityPrepared, quantityConsumed: day.quantityConsumed, quantityLeftover: day.quantityLeftover,
        }, { expect: 201 });
    }
    log(`  Chapati: ${chapatiHistory.length} logs written (LUNCH + DINNER, a steady well-managed item for contrast).`);

    for (const day of buildKitchenBHistory()) {
        await post('/api/daily-logs', kitchenB.token, {
            menuItemId: kitchenBItem.menuItem.id, logDate: day.date, mealSlot: 'LUNCH', quantityPlanned: day.quantityPlanned,
            quantityPrepared: day.quantityPrepared, quantityConsumed: day.quantityConsumed, quantityLeftover: day.quantityLeftover,
        }, { expect: 201 });
    }
    log('  Kitchen B: 7 logs written (its own short, unrelated history).');

    const flourBatch = await post('/api/processing/batches', kitchenA.token, {
        product_id: flour.data.id, log_date: localDateString(-1), input_quantity: 100, output_quantity: 85, rejects_quantity: 15, batch_number: 'MRF-0001',
    }, { expect: 201 });
    log(`  Processing batch: 100 kg input -> 85 kg output, 15 kg rejects (batch ${flourBatch.data.batch_number}).`);

    // ---- organization events (event-aware forecasting) ------------------------------------------------------
    section('Calendar events (event-aware forecasting)');
    const eventBoost = await post('/api/events', kitchenA.token, { eventDate: localDateString(7), eventType: 'special_meal', name: 'Founders Day Community Feast', expectedImpactPct: 45 }, { expect: 201 });
    const eventReduce = await post('/api/events', kitchenA.token, { eventDate: localDateString(10), eventType: 'exam', name: 'Annual Exam Week Begins', expectedImpactPct: -25 }, { expect: 201 });
    const eventClosure = await post('/api/events', kitchenA.token, { eventDate: localDateString(14), eventType: 'holiday', name: 'Public Holiday - Kitchen Closed', expectedImpactPct: -100 }, { expect: 201 });
    log(`  ${localDateString(7)}: +45% (feast), ${localDateString(10)}: -25% (exams), ${localDateString(14)}: -100% (closed).`);

    // ---- forecasts -----------------------------------------------------------------------------------------
    section('Forecasts');
    const today = localDateString(0);
    const thaliForecastToday = await get(`/api/forecasts/${thali.menuItem.id}?targetDate=${today}`, kitchenA.token);
    const chapatiForecastToday = await get(`/api/forecasts/${chapati.menuItem.id}?targetDate=${today}`, kitchenA.token);
    const boostForecast = await get(`/api/forecasts/${thali.menuItem.id}?targetDate=${localDateString(7)}`, kitchenA.token);
    const reduceForecast = await get(`/api/forecasts/${thali.menuItem.id}?targetDate=${localDateString(10)}`, kitchenA.token);
    const closureForecast = await get(`/api/forecasts/${thali.menuItem.id}?targetDate=${localDateString(14)}`, kitchenA.token);
    const baselineForDay7 = boostForecast.data.predictedQuantity / (1 + eventBoost.event.expectedImpactPct / 100);
    log(`  Veg Thali today: ${thaliForecastToday.data.predictedQuantity} (model ${thaliForecastToday.data.modelVersion}); Chapati today: ${chapatiForecastToday.data.predictedQuantity}.`);
    log(`  Founders Day: ${round1(baselineForDay7)} -> ${boostForecast.data.predictedQuantity} (event applied). Exam week: ${reduceForecast.data.predictedQuantity}. Closure day: ${closureForecast.data.predictedQuantity}.`);

    assert(thaliForecastToday.data.modelVersion === 'stat_context_v2', 'Veg Thali should have enough history for the statistical model');
    assert(thaliForecastToday.data.keyFactors.signals.weekday.active === true, 'the weekday signal should be active with 36 days of history');
    assert(boostForecast.data.keyFactors.event_context && boostForecast.data.keyFactors.event_context.adjustment.evidence === 'declared', 'the feast day should show a declared event adjustment');
    assert(boostForecast.data.predictedQuantity > baselineForDay7, 'the +45% event should raise the forecast above its own baseline');
    assert(closureForecast.data.predictedQuantity === 0, 'a -100% closure event should predict zero demand');

    // ---- prevention: one approved (today), one rejected (tomorrow) -----------------------------------------
    section('Prevention recommendations');
    const inflatedPlan = Math.round(thaliForecastToday.data.predictedQuantity * 1.35); // ~35% excess -> HIGH risk
    const recToday = await post('/api/prevention/evaluate', staffToken, { menuItemId: thali.menuItem.id, targetDate: today, plannedQuantity: inflatedPlan }, { expect: 200 });
    assert(recToday.data.riskLevel === 'HIGH', `expected HIGH risk planning ${inflatedPlan} against a forecast of ${thaliForecastToday.data.predictedQuantity}`);
    await patch(`/api/prevention/${recToday.data.recommendationId}/status`, kitchenA.token, { status: 'approved' }, { expect: 200 });
    log(`  Veg Thali, today: planned ${inflatedPlan} vs forecast ${thaliForecastToday.data.predictedQuantity} -> HIGH risk -> APPROVED (recommendation #${recToday.data.recommendationId}).`);

    const tomorrow = localDateString(1);
    const chapatiForecastTomorrow = await get(`/api/forecasts/${chapati.menuItem.id}?targetDate=${tomorrow}`, kitchenA.token);
    const moderatePlan = Math.round(chapatiForecastTomorrow.data.predictedQuantity * 1.1); // ~10% excess -> MEDIUM risk
    const recTomorrow = await post('/api/prevention/evaluate', staffToken, { menuItemId: chapati.menuItem.id, targetDate: tomorrow, plannedQuantity: moderatePlan }, { expect: 200 });
    assert(recTomorrow.data.riskLevel === 'MEDIUM', `expected MEDIUM risk planning ${moderatePlan} against a forecast of ${chapatiForecastTomorrow.data.predictedQuantity}`);
    await patch(`/api/prevention/${recTomorrow.data.recommendationId}/status`, kitchenA.token, { status: 'rejected' }, { expect: 200 });
    log(`  Chapati, tomorrow: planned ${moderatePlan} vs forecast ${chapatiForecastTomorrow.data.predictedQuantity} -> MEDIUM risk -> REJECTED (recommendation #${recTomorrow.data.recommendationId}), left open for the demo.`);

    // ---- today's actual outcome: the manager followed the recommendation -----------------------------------
    const followedQuantity = Math.round(recToday.data.recommendedQuantity * 1.05); // 5% buffer over the recommendation
    const todayDemand = Math.max(1, followedQuantity - Math.round(followedQuantity * 0.045));
    const todayLog = await post('/api/daily-logs', staffToken, {
        menuItemId: thali.menuItem.id, logDate: today, mealSlot: 'LUNCH', quantityPlanned: recToday.data.recommendedQuantity,
        quantityPrepared: followedQuantity, headcount: Math.round(todayDemand / THALI_PER_PERSON), quantityConsumed: todayDemand, quantityLeftover: followedQuantity - todayDemand,
    }, { expect: 201 });
    log(`  Today's actual: prepared ${followedQuantity} (close to the recommended ${recToday.data.recommendedQuantity}), only ${followedQuantity - todayDemand} left over.`);

    // ---- root cause -------------------------------------------------------------------------------------------
    section('Root-cause analysis');
    const dramaticCause = await get(`/api/root-causes/${thaliLogIds[DRAMATIC_OFFSET]}`, kitchenA.token);
    log(`  ${localDateString(DRAMATIC_OFFSET)}'s incident -> "${dramaticCause.data.cause}" (contribution ${dramaticCause.data.estimatedContribution}, confidence ${dramaticCause.data.confidenceScore}).`);
    assert(['low_attendance', 'over_preparation_vs_plan'].includes(dramaticCause.data.cause), 'the dramatic day should be explained by attendance or over-planning');
    assert(dramaticCause.data.estimatedContribution <= 131, 'a cause can never explain more waste than was actually left over');

    // ---- spoilage risk (three tiers: an illustrative preview, then the two real listings below) -------------
    section('Spoilage risk');
    const preview = await post('/api/surplus-listings/spoilage-estimate', staffToken, {
        foodType: 'Chicken Biryani', quantity: 5, preparedTime: hoursFromNow(-70 / 60), ambientTemperatureC: 36,
    }, { expect: 200 });
    log(`  Preview (Chicken Biryani, prepared 70 min ago, 36°C): ${preview.spoilageAssessment.riskLevel} risk, ${preview.spoilageAssessment.minutesRemaining} min remaining.`);

    // ---- surplus listings ---------------------------------------------------------------------------------
    section('Surplus listings');
    const listing1 = await post('/api/surplus-listings', staffToken, {
        quantity: 15, foodType: 'Rice, Dal and Mixed Vegetable Curry', preparedTime: hoursFromNow(-0.5), ambientTemperatureC: 31,
    }, { expect: 201 });
    const listing2 = await post('/api/surplus-listings', staffToken, {
        quantity: 10, foodType: 'Chapati and Vegetable Sabzi', preparedTime: hoursFromNow(-2), ambientTemperatureC: 29,
    }, { expect: 201 });
    log(`  Listing #${listing1.listing.id}: 15 kg, ${listing1.spoilageAssessment.riskLevel} risk. Listing #${listing2.listing.id}: 10 kg, ${listing2.spoilageAssessment.riskLevel} risk (left open for the live demo).`);
    assert(listing1.spoilageAssessment.riskLevel !== 'EXPIRED' && listing2.spoilageAssessment.riskLevel !== 'EXPIRED', 'demo listings must still be within their estimated safe window');

    // ---- NGO matching + rescue priority, before anything is claimed ----------------------------------------
    section('NGO matching');
    const matches = await get(`/api/surplus-listings/${listing1.listing.id}/ngo-matches`, kitchenA.token);
    const ranking = matches.matches.map((m) => `${m.ngoName} (${m.matchScore}, ${m.matchLevel})`).join(' > ');
    log(`  Listing #${listing1.listing.id} ranking: ${ranking}`);
    assert(matches.matches[0].ngoOrgId === ngoStrong.organization.id, 'Seva Rescue Foundation (close, ample capacity, accepts any category) should rank first');
    assert(matches.matches.every((m) => m.ngoOrgId !== ngoPending.organization.id), 'a pending (unverified) NGO must never appear in matching');

    section('Rescue priority (before collection)');
    const priorityBefore = await get('/api/rescue-priorities', admin.token);
    log(`  ${priorityBefore.data.length} active listing(s): ${priorityBefore.data.map((l) => `${l.food_type} - ${l.priorityLevel}`).join(', ')}`);

    // ---- successful claim -> confirm pickup -> collect --------------------------------------------------------
    section('Claim, pickup and collection');
    const claimed = await post(`/api/surplus-listings/${listing1.listing.id}/claim`, ngoStrong.token, { proposedPickupTime: hoursFromNow(1) }, { expect: 200 });
    assert(claimed.listing.status === 'Claimed' && claimed.listing.claimed_by_ngo_id === ngoStrong.organization.id, 'Seva Rescue Foundation should now hold the claim');
    await patch(`/api/surplus-listings/${listing1.listing.id}/confirm-pickup`, kitchenA.token, { confirmedPickupTime: hoursFromNow(1.25) }, { expect: 200 });
    const collected = await patch(`/api/surplus-listings/${listing1.listing.id}/collect`, ngoStrong.token, { quantityCollected: 15 }, { expect: 200 });
    assert(collected.listing.status === 'Collected', 'the listing should now be marked Collected');
    log(`  Listing #${listing1.listing.id}: claimed by Seva Rescue Foundation -> pickup confirmed -> collected (15 kg).`);

    // ---- financial + environmental impact --------------------------------------------------------------------
    section('Financial and environmental impact');
    const impact = await get('/api/financial-impact?period=monthly', kitchenA.token);
    log(`  Estimated loss: Rs ${impact.data.totalEstimatedLoss} | CO2e from leftovers: ${impact.data.environmentalImpact.estimatedCo2eKg} kg (${impact.data.environmentalImpact.mealEquivalents} meals)`);
    log(`  Rescued: ${impact.data.rescued.collectedQuantity} kg -> ${impact.data.rescued.mealEquivalents} meals, ${impact.data.rescued.co2eAvoidedKg} kg CO2e avoided.`);
    assert(impact.data.totalEstimatedLoss > 0, 'a month of history with real leftovers should show a nonzero loss');
    assert(impact.data.rescued.collectedQuantity === 15, 'the rescued block should reflect exactly the 15 kg just collected');
    assert(impact.data.breakdown.lossByItem['Milled Rice Flour'] > 0, 'the processing batch\'s 15 kg of rejects should appear in the loss breakdown');

    // ---- forecast vs actual -------------------------------------------------------------------------------
    section('Forecast vs actual');
    const performance = await get(`/api/analytics/forecast-performance?startDate=${localDateString(-HISTORY_DAYS)}&endDate=${today}`, kitchenA.token);
    log(`  ${performance.data.summary.evaluatedCount} item-day(s) evaluated, ${performance.data.summary.accuracyPercentage}% accuracy, trend ${performance.data.trend.direction}.`);
    assert(performance.data.summary.evaluatedCount > 0, 'weeks of logged history should produce evaluated forecast-vs-actual records');

    // ---- learning / intervention outcome -----------------------------------------------------------------
    section('Learning');
    const learning = await post('/api/learning/evaluate', kitchenA.token, { targetDate: today }, { expect: 200 });
    log(`  Recommendation #${recToday.data.recommendationId} (approved) -> effectiveness score ${learning.data[0] ? learning.data[0].effectivenessScore : 'n/a'}.`);
    assert(learning.data.length === 1 && learning.data[0].recommendationId === recToday.data.recommendationId, 'exactly the approved, already-outcome recommendation should be evaluated');
    assert(learning.data[0].effectivenessScore > 0, 'following the recommendation should score as a positive outcome');

    // ---- waste attribution ----------------------------------------------------------------------------------
    section('Waste attribution');
    const attribution = await get(`/api/analytics/waste-attribution?startDate=${localDateString(-HISTORY_DAYS)}&endDate=${today}`, kitchenA.token);
    const patterns = attribution.data.patterns.recurringOverPreparation.map((p) => p.menuItemName);
    log(`  Top contributor: ${attribution.data.topMenuItems[0].name} (${attribution.data.topMenuItems[0].contributionPercentage}% of waste). Repeated over-preparation flagged for: ${patterns.join(', ') || '(none)'}.`);
    assert(attribution.data.topMenuItems[0].name === 'Veg Thali', 'Veg Thali\'s dramatic day and over-preparation should make it the top contributor');
    assert(patterns.includes('Veg Thali'), 'the last few over-prepared days should trigger the recurring-over-preparation pattern for Veg Thali');
    assert(attribution.data.meta.mixedUnits === true, 'servings, pieces and kg should be flagged as mixed units');

    // ---- isolation check: Kitchen B never sees any of Kitchen A's data --------------------------------------
    section('Organization isolation');
    const kitchenBLogs = await get('/api/daily-logs?limit=200', kitchenB.token);
    assert(kitchenBLogs.logs.every((l) => l.menu_item_id === kitchenBItem.menuItem.id), 'Kitchen B must only ever see its own menu item\'s logs');
    await get(`/api/menu-items/${thali.menuItem.id}`, kitchenB.token, { expect: 403 }); // throws unless the API actually answers 403
    log('  Kitchen B (unrelated organization) sees only its own 7 logs, and is refused access to Kitchen A\'s menu item (403).');

    return { kitchenA, kitchenB, ngoStrong, ngoWeak, ngoPending, admin, credentials, listing1, listing2, thali, chapati };
}

function printSummary({ credentials, listing2 }) {
    section('DEMO READY');
    console.log(`All passwords: ${DEMO_PASSWORD}\n`);
    credentials.forEach((c) => console.log(`  ${c.role.padEnd(58)} ${c.email}`));
    console.log(`
Suggested walkthrough (see scripts/demo/README.md for the full script):
  1. Log in as the Kitchen A manager -> Dashboard: the full Predict/Explain/Prevent/Rescue/Learn loop.
  2. Forecast tab -> Veg Thali, target date ${localDateString(7)}: the Founders Day feast boosting demand.
  3. Root Cause tab -> the log dated ${localDateString(DRAMATIC_OFFSET)}: the AI's explanation for that day.
  4. Prevention tab: one approved, one still-pending rejected recommendation.
  5. Surplus tab: listing #${listing2.listing.id} is still Available - claim it live as the Seva Rescue Foundation NGO.
  6. Log in as the System Admin -> NGO Verification: verify "New Hope Trust" live.
  7. Forecast Accuracy / Learning tabs: the closed loop, with a real effectiveness score.

Reset everything this created: npm run demo:reset
`);
}

async function main() {
    try {
        const result = await seedDemoData();
        printSummary(result);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('\nSeeding failed:', err.message);
        console.error('No partial cleanup was attempted automatically - run `npm run demo:reset` before trying again.');
        process.exitCode = 1;
    });
}

module.exports = { seedDemoData, alreadySeeded };
