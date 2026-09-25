const express = require('express');
const router = express.Router();

const menuItemController = require('../controllers/menuItemController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { createValidators, updateValidators, idParamValidator } = require('../validators/menuItemValidators');
const { ROLES } = require('../utils/constants');

router.use(authenticate, authorize(ROLES.KITCHEN_STAFF, ROLES.KITCHEN_MANAGER));

router.post('/', createValidators, validateRequest, menuItemController.create);
router.get('/', menuItemController.list);
router.get('/:id', idParamValidator, validateRequest, menuItemController.getById);
router.patch('/:id', updateValidators, validateRequest, menuItemController.update);
router.delete(
    '/:id',
    authorize(ROLES.KITCHEN_MANAGER),
    idParamValidator,
    validateRequest,
    menuItemController.remove
);

module.exports = router;
