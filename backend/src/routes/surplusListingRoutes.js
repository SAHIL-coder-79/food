const express = require('express');
const router = express.Router();

const surplusListingController = require('../controllers/surplusListingController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const {
    createValidators,
    spoilageEstimateValidators,
    spoilageAssessmentValidators,
    claimValidators,
    confirmPickupValidators,
    collectValidators,
    idParamValidator,
    listOwnValidators,
} = require('../validators/surplusListingValidators');
const { KITCHEN_ROLES, NGO_ROLES, ROLES } = require('../utils/constants');

router.use(authenticate);

router.post(
    '/',
    authorize(...KITCHEN_ROLES),
    createValidators,
    validateRequest,
    surplusListingController.create
);
// Advisory spoilage-risk estimate preview: never blocks or changes anything, kitchen staff only.
router.post(
    '/spoilage-estimate',
    authorize(...KITCHEN_ROLES),
    spoilageEstimateValidators,
    validateRequest,
    surplusListingController.spoilageEstimate
);
router.get('/', authorize(...KITCHEN_ROLES), listOwnValidators, validateRequest, surplusListingController.listOwn);
router.get('/feed', authorize(...NGO_ROLES), surplusListingController.feed);

router.get(
    '/:id',
    authorize(...KITCHEN_ROLES, ...NGO_ROLES),
    idParamValidator,
    validateRequest,
    surplusListingController.getById
);

// Same visibility rule as viewing the listing: owning kitchen or the NGO that claimed it.
router.get(
    '/:id/spoilage-assessment',
    authorize(...KITCHEN_ROLES, ...NGO_ROLES),
    spoilageAssessmentValidators,
    validateRequest,
    surplusListingController.spoilageAssessment
);

router.post(
    '/:id/claim',
    authorize(...NGO_ROLES),
    claimValidators,
    validateRequest,
    surplusListingController.claim
);

router.patch(
    '/:id/confirm-pickup',
    authorize(...KITCHEN_ROLES),
    confirmPickupValidators,
    validateRequest,
    surplusListingController.confirmPickup
);

router.patch(
    '/:id/collect',
    authorize(...KITCHEN_ROLES, ...NGO_ROLES),
    collectValidators,
    validateRequest,
    surplusListingController.collect
);

// Ranked NGO matches for the kitchen's own listing (or system admin). Not exposed
// to NGOs: it surfaces other NGOs' derived reliability stats.
router.get(
    '/:id/ngo-matches',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    idParamValidator,
    validateRequest,
    surplusListingController.ngoMatches
);

module.exports = router;
