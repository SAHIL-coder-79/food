const pool = require('./db');

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        code: row.code,
        userId: row.user_id,
        organizationId: row.organization_id,
        provider: row.provider,
        channel: row.channel,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
        createdAt: row.created_at,
    };
}

async function create({ code, userId, organizationId, provider, channel, expiresAt }) {
    const { rows } = await pool.query(
        `INSERT INTO messaging_link_requests (code, user_id, organization_id, provider, channel, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [code, userId, organizationId, provider, channel, expiresAt]
    );
    return mapRow(rows[0]);
}

// Atomic "first (and only) redemption wins" claim - the same guarded-UPDATE pattern already used by
// surplusListingModel.claim, so two near-simultaneous attempts to redeem the same code can never both
// succeed, and an expired or already-used code is refused by the database itself, not just application logic.
async function consumeIfValid(code) {
    const { rows } = await pool.query(
        `UPDATE messaging_link_requests
         SET consumed_at = CURRENT_TIMESTAMP
         WHERE code = $1 AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
         RETURNING *`,
        [code]
    );
    return mapRow(rows[0]);
}

module.exports = { create, consumeIfValid };
