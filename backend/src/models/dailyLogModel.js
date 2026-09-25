const pool = require('./db');

const SELECT_WITH_ORG = `
    SELECT dl.*, mi.kitchen_org_id, mi.name AS menu_item_name, mi.unit AS menu_item_unit
    FROM daily_logs dl
    JOIN menu_items mi ON mi.id = dl.menu_item_id
`;

async function create({
    menuItemId,
    logDate,
    mealSlot,
    quantityPlanned,
    quantityPrepared,
    headcount,
    quantityConsumed,
    quantityLeftover,
    createdBy,
}) {
    const { rows } = await pool.query(
        `INSERT INTO daily_logs
            (menu_item_id, log_date, meal_slot, quantity_planned, quantity_prepared,
             headcount, quantity_consumed, quantity_leftover, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            menuItemId,
            logDate,
            mealSlot,
            quantityPlanned,
            quantityPrepared,
            headcount,
            quantityConsumed,
            quantityLeftover,
            createdBy,
        ]
    );
    return rows[0];
}

async function findById(id) {
    const { rows } = await pool.query(`${SELECT_WITH_ORG} WHERE dl.id = $1`, [id]);
    return rows[0] || null;
}

async function listByOrg(kitchenOrgId, filters = {}) {
    const { menuItemId, mealSlot, startDate, endDate, limit = 50, offset = 0 } = filters;
    const conditions = ['mi.kitchen_org_id = $1'];
    const values = [kitchenOrgId];
    let i = 2;

    if (menuItemId) {
        conditions.push(`dl.menu_item_id = $${i}`);
        values.push(menuItemId);
        i += 1;
    }
    if (mealSlot) {
        conditions.push(`dl.meal_slot = $${i}`);
        values.push(mealSlot);
        i += 1;
    }
    if (startDate) {
        conditions.push(`dl.log_date >= $${i}`);
        values.push(startDate);
        i += 1;
    }
    if (endDate) {
        conditions.push(`dl.log_date <= $${i}`);
        values.push(endDate);
        i += 1;
    }

    values.push(limit, offset);
    const { rows } = await pool.query(
        `${SELECT_WITH_ORG} WHERE ${conditions.join(' AND ')}
         ORDER BY dl.log_date DESC, dl.id DESC LIMIT $${i} OFFSET $${i + 1}`,
        values
    );
    return rows;
}

// Minimal, organization-scoped projection of an org's logs for analytics. Scoping happens in the
// JOIN on menu_items.kitchen_org_id; only the columns analytics needs are returned.
async function listForAnalytics(kitchenOrgId, { startDate, endDate } = {}) {
    const conditions = ['mi.kitchen_org_id = $1'];
    const values = [kitchenOrgId];
    let i = 2;

    if (startDate) {
        conditions.push(`dl.log_date >= $${i}`);
        values.push(startDate);
        i += 1;
    }
    if (endDate) {
        conditions.push(`dl.log_date <= $${i}`);
        values.push(endDate);
        i += 1;
    }

    const { rows } = await pool.query(
        `SELECT dl.log_date, dl.meal_slot, dl.menu_item_id,
                mi.name AS menu_item_name, mi.unit AS menu_item_unit,
                dl.quantity_prepared, dl.quantity_consumed, dl.quantity_leftover
         FROM daily_logs dl
         JOIN menu_items mi ON mi.id = dl.menu_item_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY dl.log_date ASC, dl.id ASC`,
        values
    );
    return rows;
}

async function update(id, fields) {
    const allowed = ['quantity_planned', 'quantity_prepared', 'headcount', 'quantity_consumed', 'quantity_leftover'];
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

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const { rows } = await pool.query(
        `UPDATE daily_logs SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
        values
    );
    return rows[0] || null;
}

async function remove(id) {
    const { rows } = await pool.query('DELETE FROM daily_logs WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
}

module.exports = { create, findById, listByOrg, listForAnalytics, update, remove };
