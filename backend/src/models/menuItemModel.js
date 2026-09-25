const pool = require('./db');

async function create({ kitchenOrgId, name, unit, costPerUnit, preparationCostPerUnit }) {
    const { rows } = await pool.query(
        `INSERT INTO menu_items (kitchen_org_id, name, unit, cost_per_unit, preparation_cost_per_unit)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [kitchenOrgId, name, unit, costPerUnit ?? 0, preparationCostPerUnit ?? 0]
    );
    return rows[0];
}

async function findById(id) {
    const { rows } = await pool.query('SELECT * FROM menu_items WHERE id = $1', [id]);
    return rows[0] || null;
}

async function listByOrg(kitchenOrgId, { includeInactive = false } = {}) {
    const activeClause = includeInactive ? '' : 'AND is_active = true';
    const { rows } = await pool.query(
        `SELECT * FROM menu_items WHERE kitchen_org_id = $1 ${activeClause} ORDER BY name ASC`,
        [kitchenOrgId]
    );
    return rows;
}

async function update(id, fields) {
    const allowed = ['name', 'unit', 'cost_per_unit', 'preparation_cost_per_unit'];
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
        `UPDATE menu_items SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
        values
    );
    return rows[0] || null;
}

async function softDelete(id) {
    const { rows } = await pool.query(
        'UPDATE menu_items SET is_active = false WHERE id = $1 RETURNING *',
        [id]
    );
    return rows[0] || null;
}

module.exports = { create, findById, listByOrg, update, softDelete };
