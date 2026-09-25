const asyncHandler = require('../utils/asyncHandler');
const menuItemService = require('../services/menuItemService');

const create = asyncHandler(async (req, res) => {
    const menuItem = await menuItemService.createMenuItem(req.user, req.body);
    res.status(201).json({ menuItem });
});

const list = asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const menuItems = await menuItemService.listMenuItems(req.user, { includeInactive });
    res.status(200).json({ menuItems });
});

const getById = asyncHandler(async (req, res) => {
    const menuItem = await menuItemService.getMenuItem(req.user, req.params.id);
    res.status(200).json({ menuItem });
});

const update = asyncHandler(async (req, res) => {
    const menuItem = await menuItemService.updateMenuItem(req.user, req.params.id, req.body);
    res.status(200).json({ menuItem });
});

const remove = asyncHandler(async (req, res) => {
    const menuItem = await menuItemService.deleteMenuItem(req.user, req.params.id);
    res.status(200).json({ menuItem });
});

module.exports = { create, list, getById, update, remove };
