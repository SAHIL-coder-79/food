const { body, query, idParam, textField, number, paginationQuery } = require('./common');
const { VERIFICATION_STATUS, ORG_TYPES } = require('../utils/constants');

const updateOrganizationValidators = [
    textField(body('name').optional(), 'Name', 255),
    body('pincode').optional().isString().withMessage('Pincode must be text').bail().trim().isLength({ max: 20 }).withMessage('Pincode is too long'),
    body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
    body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
    number(body('service_radius_km').optional({ nullable: true }), 'Service radius', { message: 'Service radius must be a positive number' }),
    number(body('capacity_kg').optional({ nullable: true }), 'Capacity', { message: 'Capacity must be a positive number' }),
    body('preferred_food_types')
        .optional({ nullable: true })
        .isArray({ max: 50 })
        .withMessage('preferred_food_types must be an array of category names'),
    body('preferred_food_types.*').optional().isString().trim().notEmpty().isLength({ max: 100 }),
];

const verifyValidators = [
    idParam('organization id'),
    body('verificationStatus')
        .isIn([VERIFICATION_STATUS.VERIFIED, VERIFICATION_STATUS.REJECTED])
        .withMessage('verificationStatus must be "verified" or "rejected"'),
];

const idParamValidator = [idParam('organization id')];

const listValidators = [
    query('type').optional().isIn(Object.values(ORG_TYPES)).withMessage(`type must be one of: ${Object.values(ORG_TYPES).join(', ')}`),
    query('verificationStatus')
        .optional()
        .isIn(Object.values(VERIFICATION_STATUS))
        .withMessage(`verificationStatus must be one of: ${Object.values(VERIFICATION_STATUS).join(', ')}`),
    ...paginationQuery,
];

module.exports = { updateOrganizationValidators, verifyValidators, idParamValidator, listValidators };
