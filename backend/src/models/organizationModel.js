const pool = require('./db');

async function create(
    { name, type, pincode, latitude, longitude, serviceRadiusKm, verificationStatus },
    client = pool
) {
    const { rows } = await client.query(
        `INSERT INTO organizations (name, type, pincode, latitude, longitude, service_radius_km, verification_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [name, type, pincode, latitude, longitude, serviceRadiusKm, verificationStatus]
    );
    return rows[0];
}

async function findById(id) {
    const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
    return rows[0] || null;
}

async function update(id, fields) {
    const allowed = ['name', 'pincode', 'latitude', 'longitude', 'service_radius_km', 'capacity_kg', 'preferred_food_types'];
    const setClauses = [];
    const values = [];
    let i = 1;

    for (const key of allowed) {
        if (fields[key] !== undefined) {
            setClauses.push(`${key} = $${i}`);
            values.push(fields[key]);
            i += 1;
        }
    }

    if (setClauses.length === 0) {
        return findById(id);
    }

    values.push(id);
    const { rows } = await pool.query(
        `UPDATE organizations SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
        values
    );
    return rows[0] || null;
}

async function updateVerificationStatus(id, verificationStatus) {
    const { rows } = await pool.query(
        'UPDATE organizations SET verification_status = $1 WHERE id = $2 RETURNING *',
        [verificationStatus, id]
    );
    return rows[0] || null;
}

async function list({ type, verificationStatus, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const values = [];
    let i = 1;

    if (type) {
        conditions.push(`type = $${i}`);
        values.push(type);
        i += 1;
    }
    if (verificationStatus) {
        conditions.push(`verification_status = $${i}`);
        values.push(verificationStatus);
        i += 1;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const { rows } = await pool.query(
        `SELECT * FROM organizations ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        values
    );
    return rows;
}

module.exports = {
    create,
    findById,
    update,
    updateVerificationStatus,
    list,
};
