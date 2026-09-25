const express = require('express');
const router = express.Router();
const { getPrioritizedListings } = require('../ai/rescuePriority');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const organizationModel = require('../models/organizationModel');
const { GENERIC_ERROR } = require('../utils/inputChecks');
const { NGO_ROLES, ROLES, VERIFICATION_STATUS } = require('../utils/constants');

// Rescue priorities are the NGO-facing view of other kitchens' available surplus, so they follow the same rules as
// the surplus feed: only NGOs (verified, and only listings inside their own service area) and system admins.
// Kitchens have no use for other kitchens' listings and must never see them.
router.get('/', authenticate, authorize(...NGO_ROLES, ROLES.SYSTEM_ADMIN), async (req, res) => {
    try {
        let ngoOrg = null;
        if (req.user.role !== ROLES.SYSTEM_ADMIN) {
            ngoOrg = req.user.organizationId ? await organizationModel.findById(req.user.organizationId) : null;
            if (!ngoOrg || ngoOrg.verification_status !== VERIFICATION_STATUS.VERIFIED) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Your organization must be verified before viewing rescue priorities'
                });
            }
        }

        const prioritizedListings = await getPrioritizedListings(req.user.organizationId, { ngoOrg });

        res.status(200).json({
            status: 'success',
            data: prioritizedListings
        });
    } catch (error) {
        console.error('Rescue Priority API error:', error);
        res.status(500).json({ status: 'error', error: GENERIC_ERROR });
    }
});

module.exports = router;
