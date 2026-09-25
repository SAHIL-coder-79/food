const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants');
const { calculateFinancialImpact } = require('../ai/financialIntelligence');

router.use(authenticate);

// GET /api/financial-impact?period=daily
router.get(
    '/',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    async (req, res) => {
        try {
            const kitchenOrgId = req.user.organizationId;
            const period = req.query.period || 'daily';

            if (!['daily', 'weekly', 'monthly'].includes(period)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid period parameter. Must be daily, weekly, or monthly.'
                });
            }

            const result = await calculateFinancialImpact(kitchenOrgId, period);

            res.json({
                status: 'success',
                data: result
            });
        } catch (error) {
            console.error('Error fetching financial impact:', error);
            res.status(500).json({ status: 'error', message: 'Internal server error' });
        }
    }
);

module.exports = router;
