const AppError = require('../utils/AppError');

// Restricts an endpoint to a fixed set of roles. Must run after `authenticate`.
function authorize(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return next(new AppError(401, 'Authentication required'));
        }
        if (!allowedRoles.includes(req.user.role)) {
            return next(new AppError(403, 'You do not have permission to perform this action'));
        }
        next();
    };
}

module.exports = authorize;
