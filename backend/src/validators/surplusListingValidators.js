const { body, query, idParam, textField, dateTime, number, paginationQuery, INT_MAX } = require('./common');
const { LISTING_STATUS } = require('../utils/constants');

const isBlank = (value) => value === undefined || value === null || value === '';

// A safe-until time is needed either from staff (safeUntilTime) or derivable from preparedTime.
const timeBasisValidator = body('safeUntilTime').custom((value, { req }) => {
    if (isBlank(value) && isBlank(req.body.preparedTime)) {
        throw new Error('Provide safeUntilTime, or preparedTime so a safe-until time can be estimated');
    }
    return true;
});

const ambientTemperatureValidator = body('ambientTemperatureC')
    .optional({ nullable: true })
    .isFloat({ min: -30, max: 60 })
    .withMessage('ambientTemperatureC must be a temperature between -30 and 60');

const positiveQuantity = (chain, label, message) => number(chain, label, { min: 0, exclusiveMin: true, message });

const createValidators = [
    body('dailyLogId').optional({ nullable: true }).isInt({ min: 1, max: INT_MAX }).withMessage('Invalid dailyLogId'),
    positiveQuantity(body('quantity'), 'Quantity', 'Quantity must be greater than 0'),
    textField(body('foodType'), 'Food type', 100),
    dateTime(body('preparedTime').optional({ nullable: true }), 'preparedTime'),
    timeBasisValidator,
    dateTime(body('safeUntilTime').optional({ nullable: true }), 'safeUntilTime'),
    ambientTemperatureValidator,
];

// Preview of the spoilage estimate (no listing is created).
const spoilageEstimateValidators = [
    textField(body('foodType'), 'Food type', 100),
    positiveQuantity(body('quantity').optional({ nullable: true }), 'Quantity', 'Quantity must be greater than 0'),
    dateTime(body('preparedTime').optional({ nullable: true }), 'preparedTime'),
    dateTime(body('safeUntilTime').optional({ nullable: true }), 'safeUntilTime'),
    body('preparedTime').custom((value, { req }) => {
        if (isBlank(value) && isBlank(req.body.safeUntilTime)) {
            throw new Error('Provide preparedTime and/or safeUntilTime');
        }
        return true;
    }),
    ambientTemperatureValidator,
];

const spoilageAssessmentValidators = [
    idParam('listing id'),
    query('ambientTemperatureC')
        .optional()
        .isFloat({ min: -30, max: 60 })
        .withMessage('ambientTemperatureC must be a temperature between -30 and 60'),
];

const claimValidators = [idParam('listing id'), dateTime(body('proposedPickupTime'), 'proposedPickupTime')];

const confirmPickupValidators = [idParam('listing id'), dateTime(body('confirmedPickupTime'), 'confirmedPickupTime')];

const collectValidators = [
    idParam('listing id'),
    positiveQuantity(body('quantityCollected'), 'quantityCollected', 'quantityCollected must be greater than 0'),
];

const idParamValidator = [idParam('listing id')];

const listOwnValidators = [
    query('status').optional().isIn(Object.values(LISTING_STATUS)).withMessage(`status must be one of: ${Object.values(LISTING_STATUS).join(', ')}`),
    ...paginationQuery,
];

module.exports = {
    createValidators,
    spoilageEstimateValidators,
    spoilageAssessmentValidators,
    claimValidators,
    confirmPickupValidators,
    collectValidators,
    idParamValidator,
    listOwnValidators,
};
