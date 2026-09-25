const { body, INT_MAX } = require('./common');

// Field-shape checks only (present, right type, sane outer bounds). The substantive image checks - size limit,
// base64 well-formedness, format sniffing - live in ai/foodQuality/service.js as AppError(400)s, matching how
// e.g. dailyLogService's menu-item ownership check works: business validation belongs to the service, not here.
const checkValidators = [
    body('imageBase64')
        .isString().withMessage('imageBase64 is required').bail()
        .notEmpty().withMessage('imageBase64 is required').bail()
        .isLength({ max: 420000 }).withMessage('Image data is too large'),
    body('mimeType').isString().withMessage('mimeType is required').bail().notEmpty().withMessage('mimeType is required'),
    body('dailyLogId').optional({ nullable: true }).isInt({ min: 1, max: INT_MAX }).withMessage('Invalid dailyLogId'),
];

module.exports = { checkValidators };
