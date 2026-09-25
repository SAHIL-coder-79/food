const express = require('express');
const router = express.Router();
const { generatePreventionRecommendation, updateRecommendationStatus } = require('../ai/prevention');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const menuItemModel = require('../models/menuItemModel');
const { idParam } = require('../validators/common');
const { parseId, parseQuantity, parseCalendarDate, GENERIC_ERROR } = require('../utils/inputChecks');
const { ROLES } = require('../utils/constants');

router.use(authenticate);

// Evaluate overproduction risk (requires KITCHEN_STAFF or KITCHEN_MANAGER)
router.post('/evaluate', authorize(ROLES.KITCHEN_STAFF, ROLES.KITCHEN_MANAGER), async (req, res) => {
    try {
        const { menuItemId, targetDate, plannedQuantity } = req.body || {};

        if (!menuItemId || !targetDate || plannedQuantity === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Every client-supplied value is checked before it can reach a query or the forecast engine.
        const parsedItemId = parseId(menuItemId);
        if (parsedItemId === null) {
            return res.status(400).json({ status: 'error', error: 'menuItemId must be a positive whole number' });
        }
        const parsedDate = parseCalendarDate(targetDate);
        if (parsedDate === null) {
            return res.status(400).json({ status: 'error', error: 'targetDate must be a real calendar date in YYYY-MM-DD format' });
        }
        const parsedQuantity = parseQuantity(plannedQuantity);
        if (parsedQuantity === null) {
            return res.status(400).json({ status: 'error', error: 'plannedQuantity must be a non-negative number' });
        }

        const kitchenOrgId = req.user.organizationId;

        // menuItemId is client-supplied - verify it actually belongs to the
        // caller's kitchen before running any forecast/prevention logic on it.
        const menuItem = await menuItemModel.findById(parsedItemId);
        if (!menuItem) {
            return res.status(404).json({ status: 'error', error: 'Menu item not found' });
        }
        if (menuItem.kitchen_org_id !== kitchenOrgId) {
            return res.status(403).json({ status: 'error', error: 'You do not have permission to perform this action' });
        }

        const evaluation = await generatePreventionRecommendation(parsedItemId, parsedDate, parsedQuantity, kitchenOrgId);

        res.status(200).json({
            status: 'success',
            data: evaluation
        });
    } catch (error) {
        console.error('Prevention evaluation error:', error);
        res.status(500).json({ status: 'error', error: GENERIC_ERROR });
    }
});

// Approve/Reject recommendation (requires KITCHEN_MANAGER)
router.patch('/:id/status', authorize(ROLES.KITCHEN_MANAGER), idParam('recommendation id'), validateRequest, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body || {};
        const kitchenOrgId = req.user.organizationId;

        const result = await updateRecommendationStatus(parseInt(id, 10), status, kitchenOrgId);

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (error) {
        // These two are the only messages updateRecommendationStatus raises on purpose; anything else is unexpected.
        if (error.message === 'Invalid status' || error.message === 'Recommendation not found or unauthorized') {
            return res.status(400).json({ status: 'error', error: error.message });
        }
        console.error('Prevention status update error:', error);
        res.status(500).json({ status: 'error', error: GENERIC_ERROR });
    }
});

module.exports = router;
