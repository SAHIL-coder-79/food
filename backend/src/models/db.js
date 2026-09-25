const { Pool, types } = require('pg');
const env = require('../config/env');

// Keep DATE columns (e.g. daily_logs.log_date) as raw 'YYYY-MM-DD' strings.
// pg's default parser builds a JS Date at LOCAL midnight, which silently
// shifts the calendar day when converted back via toISOString() in a
// non-UTC timezone — comparing plain date strings avoids that entirely.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
    connectionString: env.databaseUrl,
});

// Runs `callback(client)` inside a BEGIN/COMMIT transaction, rolling back on error.
async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = pool;
module.exports.transaction = transaction;
