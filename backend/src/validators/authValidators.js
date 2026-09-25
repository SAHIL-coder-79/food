const { body } = require('express-validator');
const { ROLES, ORG_TYPES } = require('../utils/constants');
const { textField, number, INT_MAX } = require('./common');

// bcrypt only uses the first 72 bytes of a password, so a longer one adds no strength and only costs hashing time.
const passwordValidator = body('password')
    .isString().withMessage('Password must be at least 8 characters long').bail()
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long').bail()
    .isLength({ max: 72 }).withMessage('Password must be 72 characters or fewer');

const emailValidator = body('email').isString().withMessage('A valid email is required').bail().isEmail().withMessage('A valid email is required').bail().isLength({ max: 255 }).withMessage('Email is too long').normalizeEmail();

const registerOrganizationValidators = [
    textField(body('organizationName'), 'Organization name', 255),
    body('organizationType')
        .isIn(Object.values(ORG_TYPES))
        .withMessage(`organizationType must be one of: ${Object.values(ORG_TYPES).join(', ')}`),
    body('pincode').optional().isString().withMessage('Pincode must be text').bail().trim().isLength({ max: 20 }).withMessage('Pincode is too long'),
    body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
    body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
    number(body('serviceRadiusKm').optional({ nullable: true }), 'Service radius', { message: 'Service radius must be a positive number' }),
    textField(body('name'), 'Name', 255),
    emailValidator,
    passwordValidator,
];

const loginValidators = [
    body('email').isString().withMessage('A valid email is required').bail().isEmail().withMessage('A valid email is required').normalizeEmail(),
    body('password').isString().withMessage('Password is required').bail().notEmpty().withMessage('Password is required').bail().isLength({ max: 1024 }).withMessage('Password is too long'),
];

const createUserValidators = [
    textField(body('name'), 'Name', 255),
    emailValidator,
    passwordValidator,
    body('role').isIn(Object.values(ROLES)).withMessage(`role must be one of: ${Object.values(ROLES).join(', ')}`),
    body('organizationId').optional({ nullable: true }).isInt({ min: 1, max: INT_MAX }).withMessage('Invalid organizationId'),
];

module.exports = { registerOrganizationValidators, loginValidators, createUserValidators };
