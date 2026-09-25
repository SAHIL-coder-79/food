const pool = require('./db');

const PUBLIC_COLUMNS = 'id, name, email, role, organization_id, is_active, created_at';

async function create({ name, email, passwordHash, role, organizationId }, client = pool) {
    const { rows } = await client.query(
        `INSERT INTO users (name, email, password_hash, role, organization_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PUBLIC_COLUMNS}`,
        [name, email, passwordHash, role, organizationId]
    );
    return rows[0];
}

async function findById(id) {
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] || null;
}

// Includes password_hash — only used internally by auth for credential checks.
async function findByEmailWithCredentials(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
}

async function findByEmail(email) {
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = $1`, [email]);
    return rows[0] || null;
}

async function listByOrganization(organizationId) {
    const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLUMNS} FROM users WHERE organization_id = $1 ORDER BY created_at DESC`,
        [organizationId]
    );
    return rows;
}

async function listByOrganizationAndRoles(organizationId, roles) {
    const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLUMNS} FROM users WHERE organization_id = $1 AND role = ANY($2::text[])`,
        [organizationId, roles]
    );
    return rows;
}

module.exports = {
    create,
    findById,
    findByEmail,
    findByEmailWithCredentials,
    listByOrganization,
    listByOrganizationAndRoles,
};
