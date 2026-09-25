const asyncHandler = require('../utils/asyncHandler');
const foodQualityService = require('../ai/foodQuality/service');

const check = asyncHandler(async (req, res) => {
    const { imageBase64, mimeType, dailyLogId } = req.body;
    const data = await foodQualityService.screenFoodImage(req.user, { imageBase64, mimeType, dailyLogId });
    res.status(200).json({ status: 'success', data });
});

module.exports = { check };
