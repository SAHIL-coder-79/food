const asyncHandler = require('../utils/asyncHandler');
const wasteAttributionService = require('../services/wasteAttributionService');
const forecastPerformanceService = require('../services/forecastPerformanceService');

const wasteAttribution = asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    const data = await wasteAttributionService.getWasteAttribution(req.user, { startDate, endDate });
    res.status(200).json({ status: 'success', data });
});

const forecastPerformance = asyncHandler(async (req, res) => {
    const { startDate, endDate, menuItemId, source, historyAsOf } = req.query;
    const data = await forecastPerformanceService.getForecastPerformance(req.user, { startDate, endDate, menuItemId, source, historyAsOf });
    res.status(200).json({ status: 'success', data });
});

module.exports = { wasteAttribution, forecastPerformance };
