const { query } = require('express-validator');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dateQuery = (field) =>
    query(field)
        .optional()
        .isString()
        .matches(DATE_PATTERN)
        .withMessage(`${field} must be a date in YYYY-MM-DD format`)
        .bail()
        .isISO8601({ strict: true })
        .withMessage(`${field} must be a real calendar date`);

const dateRangeValidators = [
    dateQuery('startDate'),
    dateQuery('endDate'),
    query('endDate')
        .optional()
        .custom((endDate, { req }) => {
            const { startDate } = req.query;
            if (typeof startDate === 'string' && typeof endDate === 'string' && DATE_PATTERN.test(startDate) && DATE_PATTERN.test(endDate) && startDate > endDate) {
                throw new Error('endDate must not be before startDate');
            }
            return true;
        }),
];

const wasteAttributionValidators = [...dateRangeValidators];

const forecastPerformanceValidators = [
    ...dateRangeValidators,
    query('menuItemId').optional().isInt({ min: 1, max: 2147483647 }).withMessage('menuItemId must be a positive whole number'),
    query('source').optional().isIn(['all', 'stored']).withMessage('source must be "all" or "stored"'),
    query('historyAsOf').optional().isIn(['log_date', 'recorded_at']).withMessage('historyAsOf must be "log_date" or "recorded_at"'),
];

module.exports = { wasteAttributionValidators, forecastPerformanceValidators, dateRangeValidators };
