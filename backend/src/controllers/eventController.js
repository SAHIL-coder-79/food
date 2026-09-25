const asyncHandler = require('../utils/asyncHandler');
const eventService = require('../services/eventService');

const create = asyncHandler(async (req, res) => {
    const event = await eventService.createEvent(req.user, req.body);
    res.status(201).json({ event });
});

const list = asyncHandler(async (req, res) => {
    const { startDate, endDate, eventType, limit, offset } = req.query;
    const events = await eventService.listEvents(req.user, {
        startDate,
        endDate,
        eventType,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
    });
    res.status(200).json({ events });
});

const remove = asyncHandler(async (req, res) => {
    const event = await eventService.deleteEvent(req.user, req.params.id);
    res.status(200).json({ event });
});

module.exports = { create, list, remove };
