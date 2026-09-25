const express = require('express');
const router = express.Router();

const dailyLogController = require('../controllers/dailyLogController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { createValidators, updateValidators, idParamValidator, listValidators } = require('../validators/dailyLogValidators');
const { ROLES } = require('../utils/constants');

router.use(authenticate, authorize(ROLES.KITCHEN_STAFF, ROLES.KITCHEN_MANAGER));

router.post('/', createValidators, validateRequest, dailyLogController.create);
router.get('/', listValidators, validateRequest, dailyLogController.list);
router.get('/:id', idParamValidator, validateRequest, dailyLogController.getById);
router.patch('/:id', updateValidators, validateRequest, dailyLogController.update);
router.delete('/:id', idParamValidator, validateRequest, dailyLogController.remove);

module.exports = router;
