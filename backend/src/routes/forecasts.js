const express = require('express');
const router = express.Router();
const { predictDemand } = require('../ai/forecasting');
const { normalizeTargetDate } = require('../ai/forecastEngine');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const menuItemModel = require('../models/menuItemModel');
const { idParam } = require('../validators/common');
const { GENERIC_ERROR } = require('../utils/inputChecks');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants');

router.use(authenticate);

router.get('/:menuItemId', authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN), idParam('menu item id', 'menuItemId'), validateRequest, async (req, res) => {
    try {
        const menuItemId = parseInt(req.params.menuItemId, 10);

        const menuItem = await menuItemModel.findById(menuItemId);
        if (!menuItem) {
            return res.status(404).json({ status: 'error', error: 'Menu item not found' });
        }
        if (req.user.role !== ROLES.SYSTEM_ADMIN && menuItem.kitchen_org_id !== req.user.organizationId) {
            return res.status(403).json({ status: 'error', error: 'You do not have permission to perform this action' });
        }

        let { targetDate } = req.query;

        // Default to tomorrow if no date provided
        if (!targetDate) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            targetDate = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD
        } else if (typeof targetDate !== 'string' || !normalizeTargetDate(targetDate)) {
            return res.status(400).json({ status: 'error', error: 'targetDate must be a real calendar date in YYYY-MM-DD format' });
        }

        // Optional known attendance for the target date (improves the attendance signal)
        const options = {};
        if (req.query.expectedHeadcount !== undefined) {
            const expectedHeadcount = Number(req.query.expectedHeadcount);
            if (typeof req.query.expectedHeadcount !== 'string' || !Number.isFinite(expectedHeadcount) || expectedHeadcount <= 0 || expectedHeadcount > 1000000) {
                return res.status(400).json({ status: 'error', error: 'expectedHeadcount must be a positive number' });
            }
            options.expectedHeadcount = expectedHeadcount;
        }

        // persist=false is a read-only preview (nothing is written to ai_forecasts): dashboards can show today's
        // forecast on every visit without piling up stored forecasts that the forecast-vs-actual analytics would count.
        let persist = true;
        if (req.query.persist !== undefined) {
            if (req.query.persist !== 'true' && req.query.persist !== 'false') {
                return res.status(400).json({ status: 'error', error: 'persist must be "true" or "false"' });
            }
            persist = req.query.persist === 'true';
        }

        const prediction = await predictDemand(menuItemId, targetDate, !persist, options);

        res.status(200).json({
            status: 'success',
            data: prediction
        });
    } catch (error) {
        console.error('Forecasting error:', error);
        res.status(500).json({ status: 'error', error: GENERIC_ERROR });
    }
});

module.exports = router;
