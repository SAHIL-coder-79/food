const AppError = require('../utils/AppError');

// Input validation for the processing module. Errors are AppError(400) with a specific message
// (the portal shows the message directly), and never reach the database.

const ITEM_TYPES = ['raw_material', 'finished_product', 'prepared_food'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isBlank = (value) => value === undefined || value === null || value === '';

function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
}

function requireText(value, field, maxLength) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new AppError(400, `${field} is required`);
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw new AppError(400, `${field} must be ${maxLength} characters or fewer`);
    }
    return trimmed;
}

function optionalNonNegative(value, field) {
    if (isBlank(value)) return 0;
    const n = toNumber(value);
    if (!Number.isFinite(n) || n < 0) {
        throw new AppError(400, `${field} must be a number that is zero or greater`);
    }
    return n;
}

function isRealDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseProductInput(body) {
    const data = body || {};
    const itemType = isBlank(data.item_type) ? 'raw_material' : data.item_type;
    if (!ITEM_TYPES.includes(itemType)) {
        throw new AppError(400, `item_type must be one of: ${ITEM_TYPES.join(', ')}`);
    }
    return {
        name: requireText(data.name, 'name', 255),
        unit: requireText(data.unit, 'unit', 50),
        itemType,
        costPerUnit: optionalNonNegative(data.cost_per_unit, 'cost_per_unit'),
        preparationCostPerUnit: optionalNonNegative(data.preparation_cost_per_unit, 'preparation_cost_per_unit'),
    };
}

// input_quantity = raw input, output_quantity = finished output, rejects_quantity = rejected/waste.
// All three are in the product's own unit.
function parseBatchInput(body) {
    const data = body || {};
    if (isBlank(data.product_id) || isBlank(data.log_date) || isBlank(data.input_quantity)) {
        throw new AppError(400, 'Missing required fields');
    }

    const productId = toNumber(data.product_id);
    if (!Number.isInteger(productId) || productId <= 0 || productId > 2147483647) {
        throw new AppError(400, 'product_id must be a positive whole number');
    }
    if (!isRealDate(data.log_date)) {
        throw new AppError(400, 'log_date must be a real calendar date in YYYY-MM-DD format');
    }

    const input = toNumber(data.input_quantity);
    if (!Number.isFinite(input) || input <= 0) {
        throw new AppError(400, 'input_quantity must be a number greater than zero');
    }
    const output = optionalNonNegative(data.output_quantity, 'output_quantity');
    const rejects = optionalNonNegative(data.rejects_quantity, 'rejects_quantity');
    if (rejects > input) {
        throw new AppError(400, 'rejects_quantity cannot be more than input_quantity');
    }

    let batchNumber = null;
    if (!isBlank(data.batch_number)) {
        if (typeof data.batch_number !== 'string') {
            throw new AppError(400, 'batch_number must be text');
        }
        batchNumber = data.batch_number.trim();
        if (batchNumber.length > 100) {
            throw new AppError(400, 'batch_number must be 100 characters or fewer');
        }
        if (batchNumber === '') batchNumber = null;
    }

    return { productId, logDate: data.log_date, input, output, rejects, batchNumber };
}

module.exports = { ITEM_TYPES, parseProductInput, parseBatchInput };
