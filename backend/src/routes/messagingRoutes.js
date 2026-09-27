const express = require('express');
const router = express.Router();

const messagingWebhookController = require('../controllers/messagingWebhookController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validateRequest = require('../middleware/validateRequest');
const { messagingWebhookLimiter } = require('../middleware/rateLimiter');
const { webhookValidators, linkIdentityValidators, linkRequestValidators } = require('../validators/messagingValidators');
const { KITCHEN_ROLES, NGO_ROLES } = require('../utils/constants');

// Linking a messaging identity is useful to BOTH kitchen users (to report surplus via the conversational
// assistant - Task 20) and NGO users (to receive real-time rescue notifications over WhatsApp instead of only
// email - Task 21 Part 12). Which actions a linked identity can actually TRIGGER over chat is still enforced
// separately and specifically inside services/messagingAssistantService.js (kitchen-only for surplus
// reporting) - widening who may link one does not widen who may create a surplus listing.
const LINKABLE_ROLES = [...KITCHEN_ROLES, ...NGO_ROLES];
const env = require('../config/env');

// GET webhook subscription verification (Task 21 Part 2) - Meta calls this once when you configure the
// webhook, and may re-call it if you re-verify. PUBLIC by design (it's how Meta confirms you own this
// endpoint before it will send anything to it); the verify_token comparison is what actually protects it.
router.get('/webhook', messagingWebhookController.verifyWebhookChallenge);

// The real inbound webhook - PUBLIC by design (no `authenticate`): a messaging provider calling this cannot
// present a FoodShare JWT. Security instead comes from provider.verifyWebhook (HMAC signature validation for
// Meta - Task 21 Part 3), the server-side identity mapping (never trusting a client-claimed organization/
// user/role), input validation, and the rate limiter below.
router.post('/webhook', messagingWebhookLimiter, webhookValidators, validateRequest, messagingWebhookController.receiveWebhook);

// Development/test-only simulator (Task 20 Part 14): exercises the exact same processing path as the real
// webhook (always via the mock provider, regardless of which real provider is configured), without needing a
// real provider. Refuses outright in production, in code - not just by convention.
router.post(
    '/test/inbound',
    (req, res, next) => {
        if (env.nodeEnv === 'production') {
            return res.status(404).json({ status: 'error', message: 'Not found' });
        }
        return next();
    },
    messagingWebhookLimiter,
    webhookValidators,
    validateRequest,
    messagingWebhookController.receiveTestInbound
);

// Authenticated - self-service identity linking/listing and provider status.
router.use(authenticate);
router.get('/status', messagingWebhookController.status);
router.post('/identities', authorize(...LINKABLE_ROLES), linkIdentityValidators, validateRequest, messagingWebhookController.linkIdentity);
router.get('/identities/me', authorize(...LINKABLE_ROLES), messagingWebhookController.myIdentities);
// Step 1 of the secure real-provider linking flow (Task 21 Part 9) - see services/messagingIdentityService.js.
router.post('/link-requests', authorize(...LINKABLE_ROLES), linkRequestValidators, validateRequest, messagingWebhookController.createLinkRequest);

module.exports = router;
