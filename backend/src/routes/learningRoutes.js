const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants');
const { parseCalendarDate } = require('../utils/inputChecks');
const { evaluateInterventions } = require('../ai/learning');

router.use(authenticate);

// POST /api/learning/evaluate
router.post(
    '/evaluate',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    async (req, res) => {
        try {
            const kitchenOrgId = req.user.organizationId;
            const { targetDate } = req.body || {};

            if (!targetDate) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing targetDate'
                });
            }
            const parsedDate = parseCalendarDate(targetDate);
            if (parsedDate === null) {
                return res.status(400).json({
                    status: 'error',
                    message: 'targetDate must be a real calendar date in YYYY-MM-DD format'
                });
            }

            const processedInterventions = await evaluateInterventions(kitchenOrgId, parsedDate);

            res.json({
                status: 'success',
                data: processedInterventions
            });
        } catch (error) {
            console.error('Error evaluating interventions:', error);
            res.status(500).json({ status: 'error', message: 'Internal server error' });
        }
    }
);

module.exports = router;
