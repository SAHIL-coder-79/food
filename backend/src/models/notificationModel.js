const pool = require('./db');

async function create({ userId, type, message }) {
    const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, type, message) VALUES ($1, $2, $3) RETURNING *`,
        [userId, type, message]
    );
    return rows[0];
}

// Bulk insert for fan-out notifications (e.g. surplus posted -> many NGO users).
async function createMany(notifications) {
    if (notifications.length === 0) return [];

    const values = [];
    const placeholders = notifications.map((n, idx) => {
        const base = idx * 3;
        values.push(n.userId, n.type, n.message);
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });

    const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, type, message) VALUES ${placeholders.join(', ')} RETURNING *`,
        values
    );
    return rows;
}

async function listForUser(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
    const unreadClause = unreadOnly ? 'AND is_read = false' : '';
    const { rows } = await pool.query(
        `SELECT * FROM notifications WHERE user_id = $1 ${unreadClause}
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    return rows;
}

async function markRead(id, userId) {
    const { rows } = await pool.query(
        `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *`,
        [id, userId]
    );
    return rows[0] || null;
}

async function markAllRead(userId) {
    await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [userId]);
}

module.exports = { create, createMany, listForUser, markRead, markAllRead };
