const pool = require('./db');

// organization_id / created_by are deliberately never returned to API callers.
const PUBLIC_COLUMNS = 'id, event_date, event_type, name, description, expected_impact_pct, created_at';

async function create({ organizationId, eventDate, eventType, name, description, expectedImpactPct, createdBy }) {
    const { rows } = await pool.query(
        `INSERT INTO organization_events
            (organization_id, event_date, event_type, name, description, expected_impact_pct, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${PUBLIC_COLUMNS}`,
        [organizationId, eventDate, eventType, name, description ?? null, expectedImpactPct ?? null, createdBy]
    );
    return rows[0];
}

async function listByOrg(organizationId, { startDate, endDate, eventType, limit = 200, offset = 0 } = {}) {
    const conditions = ['organization_id = $1'];
    const values = [organizationId];
    if (startDate) {
        values.push(startDate);
        conditions.push(`event_date >= $${values.length}`);
    }
    if (endDate) {
        values.push(endDate);
        conditions.push(`event_date <= $${values.length}`);
    }
    if (eventType) {
        values.push(eventType);
        conditions.push(`event_type = $${values.length}`);
    }
    values.push(limit, offset);
    const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLUMNS} FROM organization_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY event_date ASC, id ASC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
    );
    return rows;
}

// Scoped delete: another organization's event id simply matches nothing.
async function removeForOrg(id, organizationId) {
    const { rows } = await pool.query(
        `DELETE FROM organization_events WHERE id = $1 AND organization_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
        [id, organizationId]
    );
    return rows[0] || null;
}

module.exports = { create, listByOrg, removeForOrg };
