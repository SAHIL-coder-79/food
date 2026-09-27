'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Deterministic mock messaging provider: never sends anything externally. It exists so the conversational
// assistant is fully exercisable in local development, automated tests and an offline SIH demo with zero
// WhatsApp/Meta credentials. A real provider (e.g. MetaWhatsAppProvider) would implement this exact
// { name, verifyWebhook, normalizeInbound, sendMessage } shape and be selected via MESSAGING_PROVIDER.

// Webhook validation is inherently provider-specific: Meta verifies a cryptographic HMAC signature
// (X-Hub-Signature-256) over the raw request body using the app secret; this mock instead checks a plain
// shared-secret header, and only when one is actually configured (MESSAGING_WEBHOOK_SECRET), so local/mock
// testing stays frictionless by default while still being testable end to end when a secret IS set.
function verifyWebhook(req) {
    const configured = env.messagingWebhookSecret;
    if (!configured) return true;
    const provided = req.headers['x-messaging-webhook-secret'];
    return provided === configured;
}

// The mock provider has no real subscription handshake (there is nothing to subscribe to) - this exists only
// so the shared GET /webhook route can call verifyWebhookChallenge on whichever provider is configured
// without needing to know that only some providers implement it meaningfully.
function verifyWebhookChallenge() {
    return { ok: false, challenge: null };
}

// The mock's "raw" inbound shape already matches the normalized envelope the rest of the app expects (see
// validators/messagingValidators.js), since there is no real external format to translate from. A real
// provider's normalizeInbound would instead translate Meta's own webhook JSON into this same shape here -
// the conversational/business logic downstream never needs to change.
function normalizeInbound(body) {
    return {
        provider: body.provider,
        channel: body.channel,
        sender: { externalId: body.sender.externalId },
        message: { id: body.message.id, text: body.message.text },
        timestamp: body.timestamp || new Date().toISOString(),
    };
}

function sendMessage({ to, channel, body }) {
    if (typeof to !== 'string' || to.trim() === '') {
        return { provider: 'mock', accepted: false, channel: channel || null, error: 'Missing or invalid recipient address' };
    }
    if (typeof body !== 'string' || body.trim() === '') {
        return { provider: 'mock', accepted: false, channel, error: 'Message body is required' };
    }
    // Not delivered anywhere real - just acknowledged, so calling code (and tests) can inspect what WOULD
    // have been sent without any network dependency. Deterministic (same to/channel/body -> same id), matching
    // the same convention as integrations/communication/mockProvider.js, so tests never flake.
    const messageId = `mock-reply-${sha256Hex(`${to}|${channel}|${body}`).slice(0, 16)}`;
    return { provider: 'mock', accepted: true, channel, messageId };
}

module.exports = { name: 'mock', verifyWebhook, verifyWebhookChallenge, normalizeInbound, sendMessage };
