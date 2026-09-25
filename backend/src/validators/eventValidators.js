const { body, param, query } = require('express-validator');
const { EVENT_TYPES } = require('../ai/forecastEngine');
const { dateRangeValidators } = require('./analyticsValidators');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const createValidators = [
    body('eventDate')
        .isString()
        .matches(DATE_PATTERN)
        .withMessage('eventDate must be a date in YYYY-MM-DD format')
        .bail()
        .isISO8601({ strict: true })
        .withMessage('eventDate must be a real calendar date'),
    body('eventType').isIn(EVENT_TYPES).withMessage(`eventType must be one of: ${EVENT_TYPES.join(', ')}`),
    body('name').isString().withMessage('name is required').bail().trim().notEmpty().withMessage('name is required').isLength({ max: 255 }).withMessage('name must be 255 characters or fewer'),
    body('description').optional({ nullable: true }).isString().withMessage('description must be text').bail().isLength({ max: 2000 }).withMessage('description must be 2000 characters or fewer'),
    body('expectedImpactPct')
        .optional({ nullable: true })
        .isFloat({ min: -100, max: 500 })
        .withMessage('expectedImpactPct must be a number between -100 (no demand) and 500'),
];

const listValidators = [
    ...dateRangeValidators,
    query('eventType').optional().isIn(EVENT_TYPES).withMessage(`eventType must be one of: ${EVENT_TYPES.join(', ')}`),
    query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('limit must be between 1 and 500'),
    query('offset').optional().isInt({ min: 0, max: 2147483647 }).withMessage('offset must be zero or greater'),
];

const idParamValidator = [param('id').isInt({ min: 1, max: 2147483647 }).withMessage('Invalid event id')];

module.exports = { createValidators, listValidators, idParamValidator };
