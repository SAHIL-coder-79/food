'use strict';

// Removes every row seedDemo.js created, and nothing else.
//
// Scope: only organizations whose name starts with DEMO_ORG_PREFIX (plus the demo system-admin account, which has
// no organization). No table has ON DELETE CASCADE, so this deletes in dependency order — children of a demo row
// before the row itself — using only ids collected from demo organizations. A real organization that merely happens
// to be geographically close to a demo one, or that a demo NGO was scored against, is never written to; at most one
// of its ai_ngo_match_scores rows that names a demo NGO is removed (the real listing itself is untouched).
//
// Usage: node scripts/demo/resetDemo.js   (also: npm run demo:reset)

const pool = require('../../src/models/db');
const { DEMO_ORG_PREFIX, DEMO_ADMIN_EMAIL } = require('./constants');

const ids = (rows, column = 'id') => rows.map((r) => r[column]);

async function resetDemoData({ log = console.log } = {}) {
    const { rows: orgs } = await pool.query('SELECT id, name FROM organizations WHERE name LIKE $1', [`${DEMO_ORG_PREFIX}%`]);
    const orgIds = ids(orgs);

    const { rows: adminRows } = await pool.query('SELECT id FROM users WHERE email = $1 AND organization_id IS NULL', [DEMO_ADMIN_EMAIL]);
    const demoAdminId = adminRows[0] ? adminRows[0].id : null;

    if (orgIds.length === 0 && !demoAdminId) {
        log('No demo data found (no organization named "[DEMO] ..." and no demo admin account). Nothing to do.');
        return { organizationsRemoved: 0, usersRemoved: 0 };
    }

    const { rows: userRows } = orgIds.length ? await pool.query('SELECT id FROM users WHERE organization_id = ANY($1::int[])', [orgIds]) : { rows: [] };
    const userIds = ids(userRows).concat(demoAdminId ? [demoAdminId] : []);

    const { rows: menuItemRows } = orgIds.length ? await pool.query('SELECT id FROM menu_items WHERE kitchen_org_id = ANY($1::int[])', [orgIds]) : { rows: [] };
    const menuItemIds = ids(menuItemRows);

    const { rows: dailyLogRows } = menuItemIds.length ? await pool.query('SELECT id FROM daily_logs WHERE menu_item_id = ANY($1::int[])', [menuItemIds]) : { rows: [] };
    const dailyLogIds = ids(dailyLogRows);

    const { rows: listingRows } = orgIds.length
        ? await pool.query('SELECT id FROM surplus_listings WHERE kitchen_org_id = ANY($1::int[]) OR claimed_by_ngo_id = ANY($1::int[])', [orgIds])
        : { rows: [] };
    const listingIds = ids(listingRows);

    const { rows: recRows } = orgIds.length ? await pool.query('SELECT id FROM ai_prevention_recommendations WHERE kitchen_org_id = ANY($1::int[])', [orgIds]) : { rows: [] };
    const recommendationIds = ids(recRows);

    // Deletion order: every child table before the table it points at.
    if (listingIds.length) await pool.query('DELETE FROM donation_ledger_entries WHERE surplus_listing_id = ANY($1::int[])', [listingIds]);
    if (listingIds.length) await pool.query('DELETE FROM transactions_log WHERE surplus_listing_id = ANY($1::int[])', [listingIds]);
    if (listingIds.length) await pool.query('DELETE FROM ai_rescue_priorities WHERE surplus_listing_id = ANY($1::int[])', [listingIds]);
    if (listingIds.length || orgIds.length) await pool.query('DELETE FROM ai_ngo_match_scores WHERE surplus_listing_id = ANY($1::int[]) OR ngo_org_id = ANY($2::int[])', [listingIds, orgIds]);
    if (recommendationIds.length || orgIds.length) await pool.query('DELETE FROM ai_interventions WHERE recommendation_id = ANY($1::int[]) OR kitchen_org_id = ANY($2::int[])', [recommendationIds, orgIds]);
    if (orgIds.length) await pool.query('DELETE FROM ai_prevention_recommendations WHERE kitchen_org_id = ANY($1::int[])', [orgIds]);
    if (dailyLogIds.length) await pool.query('DELETE FROM ai_waste_root_causes WHERE daily_log_id = ANY($1::int[])', [dailyLogIds]);
    if (menuItemIds.length) await pool.query('DELETE FROM ai_forecasts WHERE menu_item_id = ANY($1::int[])', [menuItemIds]);
    if (orgIds.length) await pool.query('DELETE FROM ai_simulations WHERE kitchen_org_id = ANY($1::int[])', [orgIds]);
    if (orgIds.length) await pool.query('DELETE FROM ai_financial_impacts WHERE organization_id = ANY($1::int[])', [orgIds]);
    if (listingIds.length) await pool.query('DELETE FROM surplus_listings WHERE id = ANY($1::int[])', [listingIds]);
    if (menuItemIds.length) await pool.query('DELETE FROM daily_logs WHERE menu_item_id = ANY($1::int[])', [menuItemIds]);
    if (orgIds.length) await pool.query('DELETE FROM organization_events WHERE organization_id = ANY($1::int[])', [orgIds]);
    if (userIds.length) await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::int[])', [userIds]);
    if (menuItemIds.length) await pool.query('DELETE FROM menu_items WHERE id = ANY($1::int[])', [menuItemIds]);
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
    if (orgIds.length) await pool.query('DELETE FROM organizations WHERE id = ANY($1::int[])', [orgIds]);

    log(`Removed ${orgIds.length} demo organization(s) and ${userIds.length} demo user(s)${demoAdminId ? ' (including the demo system admin)' : ''}. Nothing outside "${DEMO_ORG_PREFIX}..." was touched.`);
    return { organizationsRemoved: orgIds.length, usersRemoved: userIds.length };
}

async function main() {
    try {
        await resetDemoData();
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Failed to reset demo data:', err);
        process.exitCode = 1;
    });
}

module.exports = { resetDemoData };
