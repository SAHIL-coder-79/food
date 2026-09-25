const express = require('express');
const router = express.Router();

const rescueNotificationController = require('../controllers/rescueNotificationController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { communicationLimiter } = require('../middleware/rateLimiter');
const { notifyValidators } = require('../validators/rescueNotificationValidators');
const { KITCHEN_ROLES } = require('../utils/constants');

router.use(authenticate);

// Kitchen-only: only the owning kitchen may ask FoodShare to notify NGOs about its own listing. Ownership of
// the specific listing is enforced in the service layer (it depends on the listing's own kitchen_org_id).
router.post(
    '/rescue/:listingId/notify',
    communicationLimiter,
    authorize(...KITCHEN_ROLES),
    notifyValidators,
    validateRequest,
    rescueNotificationController.notify
);

module.exports = router;
