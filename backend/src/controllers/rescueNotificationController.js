const asyncHandler = require('../utils/asyncHandler');
const rescueNotificationService = require('../services/rescueNotificationService');

const notify = asyncHandler(async (req, res) => {
    const data = await rescueNotificationService.notifyMatchedNgos(req.user, req.params.listingId);
    res.status(200).json({ status: 'success', data });
});

module.exports = { notify };
