const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');

// Collects express-validator errors and turns them into a single 400 response
// with plain-language, field-specific messages.
module.exports = function validateRequest(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const details = errors.array().map((err) => ({ field: err.path, message: err.msg }));
        return next(new AppError(400, 'Validation failed', details));
    }
    next();
};
