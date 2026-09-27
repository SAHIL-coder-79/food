const pool = require('./db');

// Append-only idempotency ledger: a successful insert means "first time we've seen this exact inbound
// message"; a unique_violation (23505) means it is a redelivery and must NOT be processed again (see
// services/messagingAssistantService.js, which relies on catching that specific error code).
async function record({ provider, channel, externalMessageId, messagingIdentityId }) {
    const { rows } = await pool.query(
        `INSERT INTO messaging_inbound_log (provider, channel, external_message_id, messaging_identity_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [provider, channel, externalMessageId, messagingIdentityId ?? null]
    );
    return rows[0];
}

module.exports = { record };
