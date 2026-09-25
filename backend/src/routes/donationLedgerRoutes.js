const express = require('express');
const router = express.Router();

const donationLedgerController = require('../controllers/donationLedgerController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { listingIdParamValidator } = require('../validators/donationLedgerValidators');
const { KITCHEN_ROLES, NGO_ROLES } = require('../utils/constants');

router.use(authenticate);

// Same visibility rule as the surplus listing itself (owning kitchen or claiming NGO) - enforced in the
// service layer, since it depends on the listing's own claimed_by_ngo_id, not on role alone.
const ALLOWED = [...KITCHEN_ROLES, ...NGO_ROLES];

router.get('/:listingId/ledger', authorize(...ALLOWED), listingIdParamValidator, validateRequest, donationLedgerController.getLedger);
router.get('/:listingId/ledger/verify', authorize(...ALLOWED), listingIdParamValidator, validateRequest, donationLedgerController.verifyLedger);
router.get('/:listingId/certificate', authorize(...ALLOWED), listingIdParamValidator, validateRequest, donationLedgerController.getCertificate);

module.exports = router;
