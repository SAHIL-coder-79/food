const express = require('express');
const router = express.Router();

const notificationController = require('../controllers/notificationController');
const authenticate = require('../middleware/authenticate');
const validateRequest = require('../middleware/validateRequest');
const { listValidators, idParamValidator } = require('../validators/notificationValidators');

router.use(authenticate);

router.get('/', listValidators, validateRequest, notificationController.list);
router.patch('/read-all', notificationController.markAllRead);
router.patch('/:id/read', idParamValidator, validateRequest, notificationController.markRead);

module.exports = router;
