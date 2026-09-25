const menuItemModel = require('../models/menuItemModel');
const AppError = require('../utils/AppError');

async function createMenuItem(actingUser, { name, unit, costPerUnit, preparationCostPerUnit }) {
    return menuItemModel.create({
        kitchenOrgId: actingUser.organizationId,
        name,
        unit,
        costPerUnit,
        preparationCostPerUnit,
    });
}

async function listMenuItems(actingUser, { includeInactive = false } = {}) {
    return menuItemModel.listByOrg(actingUser.organizationId, { includeInactive });
}

async function assertOwnedByActingUser(actingUser, id) {
    const menuItem = await menuItemModel.findById(id);
    if (!menuItem) {
        throw new AppError(404, 'Menu item not found');
    }
    if (menuItem.kitchen_org_id !== actingUser.organizationId) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    return menuItem;
}

async function getMenuItem(actingUser, id) {
    return assertOwnedByActingUser(actingUser, id);
}

async function updateMenuItem(actingUser, id, fields) {
    await assertOwnedByActingUser(actingUser, id);
    return menuItemModel.update(id, {
        name: fields.name,
        unit: fields.unit,
        cost_per_unit: fields.costPerUnit,
        preparation_cost_per_unit: fields.preparationCostPerUnit,
    });
}

async function deleteMenuItem(actingUser, id) {
    await assertOwnedByActingUser(actingUser, id);
    return menuItemModel.softDelete(id);
}

module.exports = { createMenuItem, listMenuItems, getMenuItem, updateMenuItem, deleteMenuItem };
