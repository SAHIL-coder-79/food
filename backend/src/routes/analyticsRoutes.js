const express = require('express');
const router = express.Router();

const analyticsController = require('../controllers/analyticsController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { wasteAttributionValidators, forecastPerformanceValidators } = require('../validators/analyticsValidators');
const { KITCHEN_ROLES } = require('../utils/constants');

// Kitchen roles only: analytics are computed for the caller's own kitchen (taken from the verified
// JWT, never from the request).
router.use(authenticate, authorize(...KITCHEN_ROLES));

router.get('/waste-attribution', wasteAttributionValidators, validateRequest, analyticsController.wasteAttribution);

// Forecast vs actual outcomes, accuracy trend and intervention effectiveness (read-only).
router.get('/forecast-performance', forecastPerformanceValidators, validateRequest, analyticsController.forecastPerformance);

module.exports = router;
