const express = require('express');
const router = express.Router();

const foodQualityController = require('../controllers/foodQualityController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { checkValidators } = require('../validators/foodQualityValidators');
const { KITCHEN_ROLES } = require('../utils/constants');

router.use(authenticate);

// Kitchen roles only, same as the rest of the surplus/food-preparation workflow. This is a stateless, advisory
// screening (see ai/foodQuality/service.js) - nothing is stored, and it never blocks or approves anything on its
// own; organization scoping only applies to the optional dailyLogId context, which is checked in the service.
router.post('/check', authorize(...KITCHEN_ROLES), checkValidators, validateRequest, foodQualityController.check);

module.exports = router;
