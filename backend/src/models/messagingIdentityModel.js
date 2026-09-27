const pool = require('./db');

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        provider: row.provider,
        channel: row.channel,
        externalUserId: row.external_user_id,
        userId: row.user_id,
        organizationId: row.organization_id,
        active: row.active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// Created only through an authenticated FoodShare session (see services/messagingIdentityService.js) -
// never automatically from an inbound message. The unique (provider, channel, externalUserId) constraint
// means a second link attempt for the same contact simply fails, rather than silently reassigning it.
async function create({ provider, channel, externalUserId, userId, organizationId }, client = pool) {
    const { rows } = await client.query(
        `INSERT INTO messaging_identities (provider, channel, external_user_id, user_id, organization_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [provider, channel, externalUserId, userId, organizationId]
    );
    return mapRow(rows[0]);
}

async function findByExternalContact(provider, channel, externalUserId) {
    const { rows } = await pool.query(
        `SELECT * FROM messaging_identities WHERE provider = $1 AND channel = $2 AND external_user_id = $3`,
        [provider, channel, externalUserId]
    );
    return mapRow(rows[0]);
}

async function listByUserId(userId) {
    const { rows } = await pool.query(`SELECT * FROM messaging_identities WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return rows.map(mapRow);
}

// One active identity for one user, preferring the most recently linked - used by rescueNotificationService
// to decide whether a real messaging channel (e.g. WhatsApp) is available for this person, falling back to
// the existing email-based communication provider when it is not (never assuming everyone has one linked).
async function findActiveByUserId(userId) {
    const { rows } = await pool.query(
        `SELECT * FROM messaging_identities WHERE user_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    return mapRow(rows[0]);
}

module.exports = { create, findByExternalContact, listByUserId, findActiveByUserId };
