const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants');
const { parseId, parseQuantity, parseCalendarDate } = require('../utils/inputChecks');
const { runSimulation } = require('../ai/simulator');

router.use(authenticate);

// POST /api/simulations/run
router.post(
    '/run',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    async (req, res) => {
        try {
            const kitchenOrgId = req.user.organizationId;
            const { menuItemId, targetDate, proposedQuantity } = req.body || {};

            if (!menuItemId || !targetDate || proposedQuantity === undefined) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing required parameters: menuItemId, targetDate, proposedQuantity'
                });
            }

            // Client-supplied values are checked before they reach a query or the forecast engine.
            const parsedItemId = parseId(menuItemId);
            const parsedDate = parseCalendarDate(targetDate);
            const parsedQuantity = parseQuantity(proposedQuantity);
            if (parsedItemId === null || parsedDate === null || parsedQuantity === null) {
                return res.status(400).json({
                    status: 'error',
                    message: 'menuItemId must be a positive whole number, targetDate a real date (YYYY-MM-DD) and proposedQuantity a non-negative number'
                });
            }

            const result = await runSimulation(kitchenOrgId, {
                menuItemId: parsedItemId,
                targetDate: parsedDate,
                proposedQuantity: parsedQuantity
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (error) {
            console.error('Error running simulation:', error);
            if (error.message.includes('Menu item not found')) {
                return res.status(404).json({ status: 'error', message: error.message });
            }
            res.status(500).json({ status: 'error', message: 'Internal server error' });
        }
    }
);

module.exports = router;
