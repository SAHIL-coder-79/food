const eventModel = require('../models/eventModel');
const AppError = require('../utils/AppError');

// Organization calendar events used as optional forecasting context. The organization always comes
// from the authenticated user, never from the request.

function requireOrganization(actingUser) {
    if (!actingUser.organizationId) {
        throw new AppError(403, 'This account is not associated with an organization');
    }
    return actingUser.organizationId;
}

const toView = (row) => ({
    id: row.id,
    eventDate: row.event_date,
    eventType: row.event_type,
    name: row.name,
    description: row.description,
    expectedImpactPct: row.expected_impact_pct,
    createdAt: row.created_at,
});

async function createEvent(actingUser, payload) {
    const organizationId = requireOrganization(actingUser);
    const row = await eventModel.create({
        organizationId,
        eventDate: payload.eventDate,
        eventType: payload.eventType,
        name: payload.name,
        description: payload.description,
        expectedImpactPct: payload.expectedImpactPct,
        createdBy: actingUser.id,
    });
    return toView(row);
}

async function listEvents(actingUser, filters) {
    const organizationId = requireOrganization(actingUser);
    const rows = await eventModel.listByOrg(organizationId, filters);
    return rows.map(toView);
}

async function deleteEvent(actingUser, id) {
    const organizationId = requireOrganization(actingUser);
    const row = await eventModel.removeForOrg(Number(id), organizationId);
    if (!row) {
        throw new AppError(404, 'Event not found');
    }
    return toView(row);
}

module.exports = { createEvent, listEvents, deleteEvent };
