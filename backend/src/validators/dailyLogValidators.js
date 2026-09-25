const { body, query, idParam, calendarDate, number, paginationQuery, INT_MAX } = require('./common');
const { MEAL_SLOTS } = require('../utils/constants');

const QUANTITY = 'Quantity must be a positive number';
const HEADCOUNT = 'Headcount must be a positive integer';

const quantityFields = (optionalChain) => [
    number(optionalChain('quantityPlanned'), 'Quantity', { message: QUANTITY }),
    number(optionalChain('quantityPrepared'), 'Quantity', { message: QUANTITY }),
    number(optionalChain('headcount'), 'Headcount', { integer: true, max: INT_MAX, message: HEADCOUNT }),
    number(optionalChain('quantityConsumed'), 'Quantity', { message: QUANTITY }),
    number(optionalChain('quantityLeftover'), 'Quantity', { message: QUANTITY }),
];
const optionalBody = (name) => body(name).optional({ nullable: true });

const createValidators = [
    body('menuItemId').isInt({ min: 1, max: INT_MAX }).withMessage('menuItemId is required'),
    calendarDate(body('logDate'), 'logDate'),
    body('mealSlot').isIn(MEAL_SLOTS).withMessage(`mealSlot must be one of: ${MEAL_SLOTS.join(', ')}`),
    ...quantityFields(optionalBody),
];

const updateValidators = [idParam('daily log id'), ...quantityFields(optionalBody)];

const idParamValidator = [idParam('daily log id')];

// GET /api/daily-logs filters. 'BATCH' is the meal slot production batches are stored under.
const listValidators = [
    query('menuItemId').optional().isInt({ min: 1, max: INT_MAX }).withMessage('menuItemId must be a positive whole number'),
    query('mealSlot').optional().isIn([...MEAL_SLOTS, 'BATCH']).withMessage('mealSlot is not a valid meal slot'),
    calendarDate(query('startDate').optional(), 'startDate'),
    calendarDate(query('endDate').optional(), 'endDate'),
    ...paginationQuery,
];

module.exports = { createValidators, updateValidators, idParamValidator, listValidators };
