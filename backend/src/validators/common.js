const { body, param, query } = require('express-validator');

// Largest value of a Postgres INTEGER column. Anything above it can never be a real id and would otherwise reach
// the database and come back as a 500.
const INT_MAX = 2147483647;
const QUANTITY_MAX = 1e9;
const PAGE_LIMIT_MAX = 200;

const idParam = (label, name = 'id') => param(name).isInt({ min: 1, max: INT_MAX }).withMessage(`Invalid ${label}`);

// Plain text field: must be a string (not an array/object that would be coerced into something else) of bounded length.
function textField(chain, label, max, { required = true } = {}) {
    let c = chain;
    if (!required) c = c.optional({ nullable: true });
    return c
        .isString().withMessage(`${label} must be text`).bail()
        .trim()
        .notEmpty().withMessage(required ? `${label} is required` : `${label} cannot be empty`).bail()
        .isLength({ max }).withMessage(`${label} must be ${max} characters or fewer`);
}

// A calendar date in exactly YYYY-MM-DD form (rejects week/ordinal dates and impossible days such as 2026-02-30).
function calendarDate(chain, label) {
    return chain
        .isString().bail()
        .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage(`${label} must be a date in YYYY-MM-DD format`).bail()
        .isISO8601({ strict: true }).withMessage(`${label} must be a real calendar date`);
}

// A full ISO-8601 date-time (2026-03-01T10:00:00Z); rejects bare dates, week dates and impossible days.
function dateTime(chain, label) {
    return chain
        .isString().bail()
        .matches(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/).withMessage(`${label} must be a valid date/time`).bail()
        .isISO8601({ strict: true }).withMessage(`${label} must be a valid date/time`);
}

const paginationQuery = [
    query('limit').optional().isInt({ min: 1, max: PAGE_LIMIT_MAX }).withMessage(`limit must be a whole number from 1 to ${PAGE_LIMIT_MAX}`),
    query('offset').optional().isInt({ min: 0, max: INT_MAX }).withMessage('offset must be zero or greater'),
];

module.exports = { INT_MAX, QUANTITY_MAX, PAGE_LIMIT_MAX, idParam, textField, calendarDate, dateTime, paginationQuery, body, param, query };

// A finite, bounded number sent as a JSON number or numeric string (never an array/object, which would be coerced).
function number(chain, label, { min = 0, exclusiveMin = false, max = QUANTITY_MAX, integer = false, message: customMessage } = {}) {
    const message = customMessage || `${label} must be ${exclusiveMin ? 'greater than' : 'at least'} ${min}`;
    const typeCheck = chain.custom((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
        .withMessage(`${label} must be a number`).bail();
    return integer
        ? typeCheck.isInt({ min: exclusiveMin ? min + 1 : min, max: Math.min(max, INT_MAX) }).withMessage(message)
        : typeCheck.isFloat(exclusiveMin ? { gt: min, max } : { min, max }).withMessage(message);
}

module.exports.number = number;
