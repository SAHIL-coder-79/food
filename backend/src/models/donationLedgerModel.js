const pool = require('./db');

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        surplusListingId: row.surplus_listing_id,
        sequenceNumber: row.sequence_number,
        eventType: row.event_type,
        organizationId: row.organization_id,
        actorUserId: row.actor_user_id,
        eventTimestamp: new Date(row.event_timestamp).toISOString(),
        payload: row.payload || {},
        previousHash: row.previous_hash,
        entryHash: row.entry_hash,
        createdAt: row.created_at,
    };
}

// Append-only by contract: there is no update()/remove() export. Only insertEntry and read access exist.
async function insertEntry(
    { surplusListingId, sequenceNumber, eventType, organizationId, actorUserId, eventTimestamp, payload, previousHash, entryHash },
    client = pool
) {
    const { rows } = await client.query(
        `INSERT INTO donation_ledger_entries
            (surplus_listing_id, sequence_number, event_type, organization_id, actor_user_id, event_timestamp, payload, previous_hash, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            surplusListingId,
            sequenceNumber,
            eventType,
            organizationId,
            actorUserId ?? null,
            eventTimestamp,
            JSON.stringify(payload ?? {}),
            previousHash,
            entryHash,
        ]
    );
    return mapRow(rows[0]);
}

async function getLastEntry(surplusListingId, client = pool) {
    const { rows } = await client.query(
        `SELECT * FROM donation_ledger_entries WHERE surplus_listing_id = $1 ORDER BY sequence_number DESC LIMIT 1`,
        [surplusListingId]
    );
    return mapRow(rows[0]);
}

async function listByListing(surplusListingId, client = pool) {
    const { rows } = await client.query(
        `SELECT * FROM donation_ledger_entries WHERE surplus_listing_id = $1 ORDER BY sequence_number ASC`,
        [surplusListingId]
    );
    return rows.map(mapRow);
}

module.exports = { insertEntry, getLastEntry, listByListing };
