const pool = require('./db');

// Read-only queries for forecast-vs-actual analytics. Every query is scoped to one organization via
// menu_items.kitchen_org_id (and, for recommendations, their own kitchen_org_id).
//
// NOTE on timestamps: ai_* tables store created_at as `timestamp WITHOUT time zone` (written with the
// session's CURRENT_TIMESTAMP) while daily_logs.created_at is timestamptz. The naive values are cast to
// timestamptz here, using the same session TimeZone that wrote them, so "was this forecast made before
// the outcome was recorded?" is compared as real instants regardless of the Node process timezone.

async function listLogs(kitchenOrgId, { fromDate, toDate, menuItemId }) {
    const conditions = ['mi.kitchen_org_id = $1', 'dl.log_date >= $2', 'dl.log_date <= $3'];
    const values = [kitchenOrgId, fromDate, toDate];
    if (menuItemId) {
        values.push(menuItemId);
        conditions.push(`dl.menu_item_id = $${values.length}`);
    }

    const { rows } = await pool.query(
        `SELECT dl.id, dl.menu_item_id, mi.name AS menu_item_name, mi.unit AS menu_item_unit,
                dl.log_date, dl.meal_slot, dl.quantity_planned, dl.quantity_prepared,
                dl.quantity_leftover, dl.quantity_consumed, dl.headcount, dl.created_at,
                (dl.quantity_prepared - COALESCE(dl.quantity_leftover, 0)) AS consumed
         FROM daily_logs dl
         JOIN menu_items mi ON mi.id = dl.menu_item_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY dl.log_date ASC, dl.id ASC`,
        values
    );
    return rows;
}

async function listForecasts(kitchenOrgId, { startDate, endDate, menuItemId }) {
    const conditions = ['mi.kitchen_org_id = $1', 'f.target_date >= $2', 'f.target_date <= $3'];
    const values = [kitchenOrgId, startDate, endDate];
    if (menuItemId) {
        values.push(menuItemId);
        conditions.push(`f.menu_item_id = $${values.length}`);
    }

    const { rows } = await pool.query(
        `SELECT f.id, f.menu_item_id, mi.name AS menu_item_name, mi.unit AS menu_item_unit,
                f.target_date, f.predicted_quantity, f.confidence_score, f.model_version,
                f.key_factors, f.created_at::timestamptz AS created_at
         FROM ai_forecasts f
         JOIN menu_items mi ON mi.id = f.menu_item_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY f.target_date ASC, f.created_at ASC, f.id ASC`,
        values
    );
    return rows;
}

// Approved/rejected prevention recommendations with their latest persisted intervention outcome (if the
// Learning evaluation has been run for them). Repeated evaluations append rows, so only the latest is used.
async function listDecidedRecommendations(kitchenOrgId, { startDate, endDate, menuItemId }) {
    const conditions = [
        'r.kitchen_org_id = $1',
        'mi.kitchen_org_id = $1',
        "r.status IN ('approved', 'rejected')",
        'r.target_date >= $2',
        'r.target_date <= $3',
    ];
    const values = [kitchenOrgId, startDate, endDate];
    if (menuItemId) {
        values.push(menuItemId);
        conditions.push(`r.menu_item_id = $${values.length}`);
    }

    const { rows } = await pool.query(
        `SELECT r.id, r.menu_item_id, mi.name AS menu_item_name, mi.unit AS menu_item_unit,
                r.target_date, r.status, r.risk_level, r.recommended_quantity, r.estimated_excess,
                r.created_at::timestamptz AS created_at,
                i.effectiveness_score, i.created_at::timestamptz AS evaluated_at
         FROM ai_prevention_recommendations r
         JOIN menu_items mi ON mi.id = r.menu_item_id
         LEFT JOIN LATERAL (
             SELECT effectiveness_score, created_at
             FROM ai_interventions
             WHERE recommendation_id = r.id AND kitchen_org_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT 1
         ) i ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY r.target_date ASC, r.id ASC`,
        values
    );
    return rows;
}

// The organization's calendar events (with created_at, so the engine can apply its "known by the target
// date" rule when reconstructing historical forecasts).
async function listEvents(kitchenOrgId, { fromDate, toDate }) {
    const { rows } = await pool.query(
        `SELECT event_date, event_type, name, expected_impact_pct, created_at
         FROM organization_events
         WHERE organization_id = $1 AND event_date >= $2 AND event_date <= $3
         ORDER BY event_date ASC, id ASC`,
        [kitchenOrgId, fromDate, toDate]
    );
    return rows;
}

module.exports = { listLogs, listForecasts, listDecidedRecommendations, listEvents };
