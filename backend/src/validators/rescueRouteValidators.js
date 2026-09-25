const { body, INT_MAX } = require('./common');
const env = require('../config/env');

// RESCUE_ROUTE_MAX_STOPS (see config/env.js) bounds both "too many stops" and doubles as the array's own max
// length, so a client cannot force the server to iterate over an arbitrarily large payload before validation runs.
const previewValidators = [
    body('listingIds')
        .isArray({ min: 1, max: env.rescueRouteMaxStops })
        .withMessage(`listingIds must be a non-empty array of at most ${env.rescueRouteMaxStops} listing ids`),
    body('listingIds.*').isInt({ min: 1, max: INT_MAX }).withMessage('Each listingId must be a valid id'),
    body('listingIds').custom((listingIds) => {
        if (!Array.isArray(listingIds)) return true; // reported by the isArray check above
        const unique = new Set(listingIds.map((id) => Number(id)));
        if (unique.size !== listingIds.length) {
            throw new Error('listingIds must not contain duplicates');
        }
        return true;
    }),
];

module.exports = { previewValidators };
