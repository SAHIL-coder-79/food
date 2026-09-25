const express = require('express');
const router = express.Router();

const rescueRouteController = require('../controllers/rescueRouteController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { previewValidators } = require('../validators/rescueRouteValidators');
const { NGO_ROLES } = require('../utils/constants');

router.use(authenticate);

// NGO-only: this batches an NGO's own claimed pickups, so a kitchen role has no use for it and is refused.
router.post('/preview', authorize(...NGO_ROLES), previewValidators, validateRequest, rescueRouteController.preview);

module.exports = router;
