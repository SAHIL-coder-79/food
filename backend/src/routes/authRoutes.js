const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimiter');
const { registerOrganizationValidators, loginValidators, createUserValidators } = require('../validators/authValidators');
const { ROLES } = require('../utils/constants');

// Rate limited first, before any validation work runs, since an anonymous caller can hit these with any payload.
router.post('/register-organization', registerLimiter, registerOrganizationValidators, validateRequest, authController.registerOrganization);
router.post('/login', loginLimiter, loginValidators, validateRequest, authController.login);

router.post(
    '/users',
    authenticate,
    authorize(ROLES.KITCHEN_MANAGER, ROLES.NGO_ADMIN, ROLES.SYSTEM_ADMIN),
    createUserValidators,
    validateRequest,
    authController.createUser
);

router.get('/me', authenticate, authController.me);

module.exports = router;
