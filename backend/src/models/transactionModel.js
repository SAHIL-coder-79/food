const pool = require('./db');

async function create({ surplusListingId, collectedAt, quantityCollected }, client = pool) {
    const { rows } = await client.query(
        `INSERT INTO transactions_log (surplus_listing_id, collected_at, quantity_collected)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [surplusListingId, collectedAt, quantityCollected]
    );
    return rows[0];
}

async function findByListingId(surplusListingId) {
    const { rows } = await pool.query('SELECT * FROM transactions_log WHERE surplus_listing_id = $1', [surplusListingId]);
    return rows[0] || null;
}

module.exports = { create, findByListingId };
