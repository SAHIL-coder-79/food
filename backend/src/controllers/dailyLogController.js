const asyncHandler = require('../utils/asyncHandler');
const dailyLogService = require('../services/dailyLogService');

const create = asyncHandler(async (req, res) => {
    const log = await dailyLogService.createDailyLog(req.user, req.body);
    res.status(201).json({ log });
});

const list = asyncHandler(async (req, res) => {
    const { menuItemId, mealSlot, startDate, endDate, limit, offset } = req.query;
    const logs = await dailyLogService.listDailyLogs(req.user, {
        menuItemId: menuItemId ? Number(menuItemId) : undefined,
        mealSlot,
        startDate,
        endDate,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
    });
    res.status(200).json({ logs });
});

const getById = asyncHandler(async (req, res) => {
    const log = await dailyLogService.getDailyLog(req.user, req.params.id);
    res.status(200).json({ log });
});

const update = asyncHandler(async (req, res) => {
    const log = await dailyLogService.updateDailyLog(req.user, req.params.id, req.body);
    res.status(200).json({ log });
});

const remove = asyncHandler(async (req, res) => {
    const log = await dailyLogService.deleteDailyLog(req.user, req.params.id);
    res.status(200).json({ log });
});

module.exports = { create, list, getById, update, remove };
