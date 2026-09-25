const asyncHandler = require('../utils/asyncHandler');
const rescueRouteService = require('../services/rescueRouteService');

const preview = asyncHandler(async (req, res) => {
    const data = await rescueRouteService.previewRoute(req.user, req.body.listingIds);
    res.status(200).json({ status: 'success', data });
});

module.exports = { preview };
