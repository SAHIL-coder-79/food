const express = require('express');
const router = express.Router();

const organizationController = require('../controllers/organizationController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const {
    updateOrganizationValidators,
    verifyValidators,
    idParamValidator,
    listValidators,
} = require('../validators/organizationValidators');
const { ROLES } = require('../utils/constants');

router.use(authenticate);

router.get('/me', organizationController.getMe);
router.patch(
    '/me',
    authorize(ROLES.KITCHEN_MANAGER, ROLES.NGO_ADMIN),
    updateOrganizationValidators,
    validateRequest,
    organizationController.updateMe
);

router.get('/pending-ngos', authorize(ROLES.SYSTEM_ADMIN), listValidators, validateRequest, organizationController.listPendingNgos);

router.get('/', listValidators, validateRequest, organizationController.list);
router.get('/:id', idParamValidator, validateRequest, organizationController.getById);
router.patch(
    '/:id/verify',
    authorize(ROLES.SYSTEM_ADMIN),
    verifyValidators,
    validateRequest,
    organizationController.verify
);

module.exports = router;
