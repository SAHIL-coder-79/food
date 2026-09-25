const express = require('express');
const router = express.Router();
const processingController = require('../controllers/processingController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { KITCHEN_ROLES, ROLES } = require('../utils/constants'); // We reuse KITCHEN_ROLES for processing orgs as well for now

router.use(authenticate);

// We assume users in a 'processing' organization still map to the same backend roles (KITCHEN_MANAGER/KITCHEN_STAFF) 
// for simplicity in this phase, or we just authorize them.

router.get(
    '/products',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    processingController.getProducts
);

router.post(
    '/products',
    authorize(ROLES.KITCHEN_MANAGER, ROLES.SYSTEM_ADMIN),
    processingController.createProduct
);

router.get(
    '/batches',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    processingController.getBatches
);

router.post(
    '/batches',
    authorize(...KITCHEN_ROLES, ROLES.SYSTEM_ADMIN),
    processingController.logBatch
);

module.exports = router;
