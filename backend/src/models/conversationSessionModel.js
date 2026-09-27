const pool = require('./db');

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        messagingIdentityId: row.messaging_identity_id,
        intent: row.intent,
        state: row.state,
        pendingPayload: row.pending_payload || {},
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

async function findByIdentityId(messagingIdentityId) {
    const { rows } = await pool.query(`SELECT * FROM conversation_sessions WHERE messaging_identity_id = $1`, [messagingIdentityId]);
    return mapRow(rows[0]);
}

// One row per identity, always replaced (never accumulated) - see migration 013's UNIQUE(messaging_identity_id).
// This is intentionally an upsert: a conversation only ever has ONE pending thing at a time.
async function upsert({ messagingIdentityId, intent, state, pendingPayload, expiresAt }) {
    const { rows } = await pool.query(
        `INSERT INTO conversation_sessions (messaging_identity_id, intent, state, pending_payload, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (messaging_identity_id) DO UPDATE SET
             intent = EXCLUDED.intent,
             state = EXCLUDED.state,
             pending_payload = EXCLUDED.pending_payload,
             expires_at = EXCLUDED.expires_at,
             updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [messagingIdentityId, intent, state, JSON.stringify(pendingPayload || {}), expiresAt]
    );
    return mapRow(rows[0]);
}

async function clearByIdentityId(messagingIdentityId) {
    await pool.query(`DELETE FROM conversation_sessions WHERE messaging_identity_id = $1`, [messagingIdentityId]);
}

module.exports = { findByIdentityId, upsert, clearByIdentityId };
