const dailyLogModel = require('../models/dailyLogModel');
const menuItemModel = require('../models/menuItemModel');
const AppError = require('../utils/AppError');
const { ROLES } = require('../utils/constants');

// Uses the server's local calendar date (not UTC) so the day-end lock lines
// up with the "11:59 PM same day" business rule. log_date comes back from
// the DB as a raw 'YYYY-MM-DD' string (see models/db.js DATE type parser).
function todayDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isEditableByStaff(logDate) {
    return String(logDate).slice(0, 10) === todayDateString();
}

async function assertMenuItemBelongsToOrg(menuItemId, organizationId) {
    const menuItem = await menuItemModel.findById(menuItemId);
    if (!menuItem || !menuItem.is_active) {
        throw new AppError(404, 'Menu item not found');
    }
    if (menuItem.kitchen_org_id !== organizationId) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    return menuItem;
}

async function createDailyLog(actingUser, payload) {
    await assertMenuItemBelongsToOrg(payload.menuItemId, actingUser.organizationId);

    return dailyLogModel.create({
        menuItemId: payload.menuItemId,
        logDate: payload.logDate,
        mealSlot: payload.mealSlot,
        quantityPlanned: payload.quantityPlanned ?? null,
        quantityPrepared: payload.quantityPrepared ?? null,
        headcount: payload.headcount ?? null,
        quantityConsumed: payload.quantityConsumed ?? null,
        quantityLeftover: payload.quantityLeftover ?? null,
        createdBy: actingUser.id,
    });
}

async function listDailyLogs(actingUser, filters) {
    return dailyLogModel.listByOrg(actingUser.organizationId, filters);
}

async function assertOwnedByActingUser(actingUser, id) {
    const log = await dailyLogModel.findById(id);
    if (!log) {
        throw new AppError(404, 'Daily log not found');
    }
    if (log.kitchen_org_id !== actingUser.organizationId) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    return log;
}

function assertEditWindow(actingUser, log) {
    if (actingUser.role === ROLES.KITCHEN_MANAGER) {
        return; // managers may correct historical entries
    }
    if (!isEditableByStaff(log.log_date)) {
        throw new AppError(403, 'Log entries can only be edited on the same day (day-end lock has passed)');
    }
}

async function getDailyLog(actingUser, id) {
    return assertOwnedByActingUser(actingUser, id);
}

async function updateDailyLog(actingUser, id, fields) {
    const log = await assertOwnedByActingUser(actingUser, id);
    assertEditWindow(actingUser, log);
    return dailyLogModel.update(id, {
        quantity_planned: fields.quantityPlanned,
        quantity_prepared: fields.quantityPrepared,
        headcount: fields.headcount,
        quantity_consumed: fields.quantityConsumed,
        quantity_leftover: fields.quantityLeftover,
    });
}

async function deleteDailyLog(actingUser, id) {
    const log = await assertOwnedByActingUser(actingUser, id);
    assertEditWindow(actingUser, log);
    return dailyLogModel.remove(id);
}

module.exports = { createDailyLog, listDailyLogs, getDailyLog, updateDailyLog, deleteDailyLog };
