const { normalizeTargetDate } = require('../ai/forecastEngine');

// Strict parsers for the few routes that read raw request bodies/params themselves. Each returns the parsed value,
// or null when the input is not acceptable, so a caller can answer 400 instead of letting bad input reach the
// database (where it becomes a 500 with an internal error message).

const INT_MAX = 2147483647; // largest Postgres INTEGER
const QUANTITY_MAX = 1e9;

// A positive whole-number id (number or digits-only string) that fits a Postgres INTEGER.
function parseId(value) {
    let n = NaN;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^\d{1,10}$/.test(value.trim())) n = Number(value.trim());
    return Number.isInteger(n) && n >= 1 && n <= INT_MAX ? n : null;
}

// A finite, non-negative, bounded number (number or numeric string). Arrays/objects/booleans are rejected.
function parseQuantity(value, { allowZero = true } = {}) {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > QUANTITY_MAX) return null;
    if (!allowZero && n === 0) return null;
    return n;
}

// A real calendar date written exactly as YYYY-MM-DD.
function parseCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    return normalizeTargetDate(value);
}

// The message returned for an unexpected server error: never the underlying (database) error text.
const GENERIC_ERROR = 'Something went wrong, please try again';

module.exports = { INT_MAX, QUANTITY_MAX, parseId, parseQuantity, parseCalendarDate, GENERIC_ERROR };
