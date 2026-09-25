const express = require('express');
const router = express.Router();

const eventController = require('../controllers/eventController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { createValidators, listValidators, idParamValidator } = require('../validators/eventValidators');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants');

router.use(authenticate);

// The organization's own calendar: anyone in the kitchen can read it, only managers change it.
router.get('/', authorize(...KITCHEN_ROLES), listValidators, validateRequest, eventController.list);
router.post('/', authorize(ROLES.KITCHEN_MANAGER), createValidators, validateRequest, eventController.create);
router.delete('/:id', authorize(ROLES.KITCHEN_MANAGER), idParamValidator, validateRequest, eventController.remove);

module.exports = router;
