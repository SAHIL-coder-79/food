const asyncHandler = require('../utils/asyncHandler');
const messagingService = require('../integrations/messaging/service');
const messagingAssistantService = require('../services/messagingAssistantService');
const messagingIdentityService = require('../services/messagingIdentityService');
const AppError = require('../utils/AppError');
const env = require('../config/env');

// The ACTIVE provider is always decided by server-side configuration (env.messagingProvider), never by
// anything in the request itself - Meta's real webhook payload has no "provider" field to trust anyway, and
// trusting a client-claimed one would let a caller pick which verification logic runs (e.g. claim "mock" to
// skip Meta's HMAC check even when MESSAGING_PROVIDER=meta is configured).
function makeReceiveHandler(providerOverride) {
    return asyncHandler(async (req, res) => {
        const providerName = providerOverride || env.messagingProvider;

        let verified;
        try {
            verified = messagingService.verifyWebhook(providerName, req);
        } catch (error) {
            throw new AppError(400, error.message);
        }
        if (!verified) {
            throw new AppError(401, 'Webhook signature/secret verification failed');
        }

        let normalized;
        try {
            normalized = messagingService.normalizeInbound(providerName, req.body);
        } catch (error) {
            throw new AppError(400, `Could not normalize inbound message: ${error.message}`);
        }

        if (!normalized) {
            // Nothing actionable (e.g. a Meta delivery-status/read-receipt callback, not a new message) -
            // still acknowledge with 200 so the provider does not treat this as a failed delivery and retry.
            return res.status(200).json({ status: 'success', data: { duplicate: false, reply: null, ignored: true } });
        }
        if (!normalized.sender || !normalized.message) {
            throw new AppError(400, 'Malformed inbound message');
        }

        const result = await messagingAssistantService.handleInboundMessage(normalized);
        res.status(200).json({ status: 'success', data: result });
    });
}

// The simple, ergonomic shape this local mock adapter accepts in addition to the full normalized envelope:
// { "from": "demo-kitchen-whatsapp", "message": "..." }. Always treated as the mock provider directly - no
// signature concept applies to this dev-only endpoint. Returns null (falls back to the existing envelope-shape
// path below) for anything that isn't this exact simple shape, so the { provider, channel, sender:
// {externalId}, message: {id, text} } envelope already used by the Task 20/21 test suite keeps working
// unchanged.
//
// NOTE ON IDEMPOTENCY: each call here generates a fresh, random message id, since the simple shape has no
// concept of a stable provider-issued message id to key on (unlike a real webhook redelivery, which reuses
// the exact same id). This is the correct behaviour for this shape - it lets the same text (e.g. a second,
// genuine "YES" after a new report) be treated as a new message rather than permanently "already handled".
// True redelivery/idempotency testing uses the full envelope shape with an explicit message.id instead - see
// tests/messagingAssistantApi.test.js and tests/messagingMetaFlow.test.js.
function normalizeSimpleTestBody(body) {
    if (typeof body.from !== 'string' || typeof body.message !== 'string') {
        return null;
    }
    return {
        provider: 'mock',
        channel: 'whatsapp',
        sender: { externalId: body.from },
        message: { id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, text: body.message },
        timestamp: new Date().toISOString(),
    };
}

// Shapes the richer, development-friendly response this local mock adapter returns, on top of (never instead
// of) the original { status, data: { duplicate, reply } } shape every existing caller/test already relies on.
function buildTestResponseBody(result) {
    const body = {
        status: 'success',
        success: true,
        stage: result.stage,
        message: result.reply,
        data: { duplicate: result.duplicate, reply: result.reply },
    };
    if (result.pendingAction) {
        body.pendingAction = result.pendingAction;
    }
    if (result.listing) {
        body.listingId = result.listing.id;
        // A deliberately small, non-sensitive subset - never the full raw database row.
        body.surplus = {
            id: result.listing.id,
            quantity: result.listing.quantity,
            foodType: result.listing.food_type,
            status: result.listing.status,
            safeUntilTime: result.listing.safe_until_time,
        };
    }
    return body;
}

// Development/test-only local mock WhatsApp inbound adapter (see routes/messagingRoutes.js - refused with a
// 404 whenever NODE_ENV=production, in code). Exercises the EXACT SAME shared inbound service, parser and
// confirmation handling the real Meta webhook will call in production (services/messagingAssistantService.js
// is untouched by this file) - only the request-shape flexibility, optional demo-identity auto-linking, and
// the richer JSON response below are specific to this adapter.
const receiveTestInbound = asyncHandler(async (req, res) => {
    const providerName = 'mock';
    let normalized = normalizeSimpleTestBody(req.body);

    if (!normalized) {
        const verified = messagingService.verifyWebhook(providerName, req);
        if (!verified) {
            throw new AppError(401, 'Webhook signature/secret verification failed');
        }
        try {
            normalized = messagingService.normalizeInbound(providerName, req.body);
        } catch (error) {
            throw new AppError(400, `Could not normalize inbound message: ${error.message}`);
        }
    }

    if (!normalized) {
        return res.status(200).json({ status: 'success', success: true, stage: 'ignored', data: { duplicate: false, reply: null, ignored: true } });
    }
    if (!normalized.sender || !normalized.message) {
        throw new AppError(400, 'Malformed inbound message');
    }

    // LOCAL DEVELOPMENT/DEMO ONLY - see messagingIdentityService.ensureDemoIdentityIfConfigured. Never called
    // from the real webhook handler above; this is what lets "demo-kitchen-whatsapp" work out of the box.
    await messagingIdentityService.ensureDemoIdentityIfConfigured(normalized.provider, normalized.channel, normalized.sender.externalId);

    const result = await messagingAssistantService.handleInboundMessage(normalized);
    res.status(200).json(buildTestResponseBody(result));
});

// GET /api/messaging/webhook - Meta's (or another real provider's) one-time/re-verifiable webhook subscription
// handshake. Always checked against the currently configured provider; an invalid or missing mode/token is
// rejected with 403, never a 200 (Task 21 Part 2: "Incorrect verification requests must be rejected").
const verifyWebhookChallenge = (req, res) => {
    const result = messagingService.verifyWebhookChallenge(env.messagingProvider, req.query);
    if (!result.ok) {
        return res.status(403).json({ status: 'error', message: 'Webhook verification failed' });
    }
    return res.status(200).type('text/plain').send(result.challenge);
};

const receiveWebhook = makeReceiveHandler(null);

const linkIdentity = asyncHandler(async (req, res) => {
    const identity = await messagingIdentityService.linkIdentity(req.user, req.body);
    res.status(201).json({ status: 'success', data: identity });
});

const myIdentities = asyncHandler(async (req, res) => {
    const identities = await messagingIdentityService.listOwnIdentities(req.user);
    res.status(200).json({ status: 'success', data: identities });
});

const createLinkRequest = asyncHandler(async (req, res) => {
    const linkRequest = await messagingIdentityService.createLinkRequest(req.user, req.body);
    res.status(201).json({ status: 'success', data: linkRequest });
});

// Never returns secrets/config values themselves - only whether messaging is on and which provider is active,
// which is safe to show a kitchen user deciding whether WhatsApp linking is even available right now.
const status = (req, res) => {
    res.status(200).json({ status: 'success', data: { enabled: env.messagingEnabled, provider: env.messagingProvider } });
};

module.exports = { receiveWebhook, receiveTestInbound, verifyWebhookChallenge, linkIdentity, myIdentities, createLinkRequest, status };
