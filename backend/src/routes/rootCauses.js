const express = require('express');
const router = express.Router();
const { analyzeWasteRootCause } = require('../ai/rootCause');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const dailyLogModel = require('../models/dailyLogModel');
const { idParam } = require('../validators/common');
const { GENERIC_ERROR } = require('../utils/inputChecks');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants');

router.use(authenticate);

router.get('/:dailyLogId', authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN), idParam('daily log id', 'dailyLogId'), validateRequest, async (req, res) => {
    try {
        const dailyLogId = parseInt(req.params.dailyLogId, 10);

        const dailyLog = await dailyLogModel.findById(dailyLogId);
        if (!dailyLog) {
            return res.status(404).json({ status: 'error', error: 'Daily log not found' });
        }
        if (req.user.role !== ROLES.SYSTEM_ADMIN && dailyLog.kitchen_org_id !== req.user.organizationId) {
            return res.status(403).json({ status: 'error', error: 'You do not have permission to perform this action' });
        }

        const analysis = await analyzeWasteRootCause(dailyLogId);

        res.status(200).json({
            status: 'success',
            data: analysis
        });
    } catch (error) {
        if (error.message === 'Daily log not found') {
            return res.status(404).json({ status: 'error', error: error.message });
        }
        console.error('Root Cause Analysis error:', error);
        res.status(500).json({ status: 'error', error: GENERIC_ERROR });
    }
});

module.exports = router;
