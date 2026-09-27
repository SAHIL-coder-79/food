const { body } = require('./common');

// A real WhatsApp text message is capped at 4096 characters by the platform itself; even with a provider's
// full JSON envelope wrapped around it (contacts/metadata/etc.), a genuine webhook delivery for one message
// stays well under this. Bounding the RAW body size here - rather than one specific nested field - is what
// stays provider-agnostic: Meta's real payload shape looks nothing like the mock provider's normalized
// envelope, so per-field validation would only ever fit one provider's format.
const MAX_WEBHOOK_BODY_BYTES = 20 * 1024;

// The webhook body's actual shape is entirely provider-specific - see integrations/messaging/
// {mockProvider,metaProvider}.js's own normalizeInbound, which is the right place for structural validation.
// Here we only guard against a request with no JSON object body at all, and bound its overall size.
const webhookValidators = [
    body()
        .custom((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
        .withMessage('Request body must be a JSON object'),
    body().custom((_value, { req }) => {
        if (req.rawBody && req.rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
            throw new Error(`Webhook payload is too large (max ${MAX_WEBHOOK_BODY_BYTES} bytes for a single message)`);
        }
        return true;
    }),
];

const linkIdentityValidators = [
    body('provider').isString().withMessage('provider is required').bail().trim().notEmpty().isLength({ max: 50 }),
    body('channel').isString().withMessage('channel is required').bail().trim().notEmpty().isLength({ max: 50 }),
    body('externalUserId').isString().withMessage('externalUserId is required').bail().trim().notEmpty().isLength({ max: 255 }),
];

const linkRequestValidators = [
    body('provider').isString().withMessage('provider is required').bail().trim().notEmpty().isLength({ max: 50 }),
    body('channel').isString().withMessage('channel is required').bail().trim().notEmpty().isLength({ max: 50 }),
];

module.exports = { webhookValidators, linkIdentityValidators, linkRequestValidators };
