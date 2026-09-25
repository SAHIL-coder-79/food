const express = require('express');
const router = express.Router();

router.use('/', require('./health'));
router.use('/auth', require('./authRoutes'));
router.use('/organizations', require('./organizationRoutes'));
router.use('/menu-items', require('./menuItemRoutes'));
router.use('/daily-logs', require('./dailyLogRoutes'));
router.use('/surplus-listings', require('./surplusListingRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/analytics', require('./analyticsRoutes'));
router.use('/events', require('./eventRoutes'));

module.exports = router;
