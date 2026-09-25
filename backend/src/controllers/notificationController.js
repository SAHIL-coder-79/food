const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const list = asyncHandler(async (req, res) => {
    const { unreadOnly, limit, offset } = req.query;
    const notifications = await notificationService.listForUser(req.user.id, {
        unreadOnly: unreadOnly === 'true',
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
    });
    res.status(200).json({ notifications });
});

const markRead = asyncHandler(async (req, res) => {
    const notification = await notificationService.markRead(req.params.id, req.user.id);
    if (!notification) {
        return res.status(404).json({ status: 'error', message: 'Notification not found' });
    }
    res.status(200).json({ notification });
});

const markAllRead = asyncHandler(async (req, res) => {
    await notificationService.markAllRead(req.user.id);
    res.status(204).send();
});

module.exports = { list, markRead, markAllRead };
