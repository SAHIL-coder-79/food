const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const userModel = require('../models/userModel');

// Verifies the JWT and attaches the current user's identity to req.user.
// req.user.organizationId / req.user.role are the ONLY trusted source of
// identity/org for downstream handlers — client-supplied ids are never trusted.
module.exports = asyncHandler(async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
        throw new AppError(401, 'Authentication token missing or malformed');
    }

    let payload;
    try {
        // Only the algorithm this app signs with is accepted (no algorithm switching).
        payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
    } catch (error) {
        throw new AppError(401, 'Invalid or expired token');
    }

    // The subject must be a real user id; anything else is not a token this app issued.
    const subject = typeof payload.sub === 'number' ? payload.sub : Number(payload.sub);
    if (!Number.isInteger(subject) || subject < 1 || subject > 2147483647) {
        throw new AppError(401, 'Invalid or expired token');
    }

    const user = await userModel.findById(subject);
    if (!user || !user.is_active) {
        throw new AppError(401, 'Account no longer active');
    }

    req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organization_id,
    };

    next();
});
