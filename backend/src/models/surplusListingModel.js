const pool = require('./db');
const { LISTING_STATUS } = require('../utils/constants');

async function create({ dailyLogId, kitchenOrgId, quantity, foodType, preparedTime, safeUntilTime }, client = pool) {
    const { rows } = await client.query(
        `INSERT INTO surplus_listings
            (daily_log_id, kitchen_org_id, quantity, food_type, prepared_time, safe_until_time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [dailyLogId, kitchenOrgId, quantity, foodType, preparedTime, safeUntilTime, LISTING_STATUS.AVAILABLE]
    );
    return rows[0];
}

async function findById(id) {
    const { rows } = await pool.query('SELECT * FROM surplus_listings WHERE id = $1', [id]);
    return rows[0] || null;
}

// Batch lookup joined with the kitchen's own coordinates (a listing's pickup point is its kitchen's location -
// there is no separate per-listing location model). Used by the rescue-route planner (services/rescueRouteService.js)
// to fetch several candidate stops in one query instead of one round trip per listing id.
async function findByIdsWithKitchenLocation(ids) {
    if (ids.length === 0) return [];
    const { rows } = await pool.query(
        `SELECT sl.*, o.latitude AS kitchen_latitude, o.longitude AS kitchen_longitude, o.name AS kitchen_name
         FROM surplus_listings sl
         JOIN organizations o ON o.id = sl.kitchen_org_id
         WHERE sl.id = ANY($1::int[])`,
        [ids]
    );
    return rows;
}

async function listByKitchenOrg(kitchenOrgId, { status, limit = 50, offset = 0 } = {}) {
    const conditions = ['kitchen_org_id = $1'];
    const values = [kitchenOrgId];
    let i = 2;

    if (status) {
        conditions.push(`status = $${i}`);
        values.push(status);
        i += 1;
    }

    values.push(limit, offset);
    const { rows } = await pool.query(
        `SELECT * FROM surplus_listings WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        values
    );
    return rows;
}

// Marks any stale Available listings as Expired. Returns the rows that were
// flipped so callers can raise notifications for them.
async function expireStaleListings(client = pool) {
    const { rows } = await client.query(
        `UPDATE surplus_listings
         SET status = $1
         WHERE status = $2 AND safe_until_time < CURRENT_TIMESTAMP
         RETURNING *`,
        [LISTING_STATUS.EXPIRED, LISTING_STATUS.AVAILABLE]
    );
    return rows;
}

// Active listings joined with kitchen org location, for NGO feed distance/radius filtering.
async function listActiveForFeed() {
    const { rows } = await pool.query(
        `SELECT sl.*, o.name AS kitchen_name, o.pincode AS kitchen_pincode,
                o.latitude AS kitchen_latitude, o.longitude AS kitchen_longitude
         FROM surplus_listings sl
         JOIN organizations o ON o.id = sl.kitchen_org_id
         WHERE sl.status = $1 AND sl.safe_until_time > CURRENT_TIMESTAMP
         ORDER BY sl.safe_until_time ASC`,
        [LISTING_STATUS.AVAILABLE]
    );
    return rows;
}

// Atomic "first-claim-wins" update: only succeeds if the listing is still Available.
async function claim(id, { ngoOrgId, userId, proposedPickupTime }, client = pool) {
    const { rows } = await client.query(
        `UPDATE surplus_listings
         SET status = $1, claimed_by_ngo_id = $2, claimed_by_user_id = $3,
             claimed_at = CURRENT_TIMESTAMP, proposed_pickup_time = $4
         WHERE id = $5 AND status = $6 AND safe_until_time > CURRENT_TIMESTAMP
         RETURNING *`,
        [LISTING_STATUS.CLAIMED, ngoOrgId, userId, proposedPickupTime, id, LISTING_STATUS.AVAILABLE]
    );
    return rows[0] || null;
}

async function confirmPickup(id, kitchenOrgId, confirmedPickupTime, client = pool) {
    const { rows } = await client.query(
        `UPDATE surplus_listings
         SET confirmed_pickup_time = $1
         WHERE id = $2 AND kitchen_org_id = $3 AND status = $4
         RETURNING *`,
        [confirmedPickupTime, id, kitchenOrgId, LISTING_STATUS.CLAIMED]
    );
    return rows[0] || null;
}

async function collect(id, { collectedByUserId, quantityCollected }, allowedOrgIds, client = pool) {
    const { rows } = await client.query(
        `UPDATE surplus_listings
         SET status = $1, collected_at = CURRENT_TIMESTAMP, collected_by_user_id = $2
         WHERE id = $3 AND status = $4 AND (kitchen_org_id = ANY($5::int[]) OR claimed_by_ngo_id = ANY($5::int[]))
         RETURNING *`,
        [LISTING_STATUS.COLLECTED, collectedByUserId, id, LISTING_STATUS.CLAIMED, allowedOrgIds]
    );
    return rows[0] || null;
}

module.exports = {
    create,
    findById,
    findByIdsWithKitchenLocation,
    listByKitchenOrg,
    expireStaleListings,
    listActiveForFeed,
    claim,
    confirmPickup,
    collect,
};
