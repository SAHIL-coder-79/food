'use strict';

// Real Meta WhatsApp Cloud API provider - implements the exact same 4-method contract as mockProvider.js
// (name, verifyWebhook, normalizeInbound, sendMessage), plus one additive method (verifyWebhookChallenge) for
// the GET webhook-subscription handshake that only a provider with a real subscription mechanism needs (the
// mock provider has none). No other file in the app knows this is "Meta" - the conversational assistant and
// messagingAssistantService.js only ever see the shared normalized envelope.
//
// Verified against Meta's current Graph API webhooks documentation and WhatsApp Cloud API reference
// (developers.facebook.com/docs/graph-api/webhooks, developers.facebook.com/docs/whatsapp/cloud-api) at the
// time this was written - current Graph API version was v26.0. Re-verify before relying on this in production;
// Meta deprecates old API versions on a rolling schedule.

const crypto = require('crypto');
const env = require('../../config/env');

const SUPPORTED_TEXT_TYPE = 'text';
const CHANNEL = 'whatsapp';

function timingSafeEqualStrings(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    // Constant-time comparison requires equal-length buffers; a length mismatch is itself decided in constant
    // time relative to the SHORTER input by comparing against a same-length buffer first, then failing.
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // burn equivalent time, never branch early on length alone
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// GET /api/messaging/webhook - Meta's one-time (and re-verifiable) webhook subscription handshake. Per the
// current docs: echo back `hub.challenge` only when `hub.mode` is exactly "subscribe" and `hub.verify_token`
// matches the value configured server-side (META_WHATSAPP_VERIFY_TOKEN) - a value WE choose, entered into the
// Meta App Dashboard, never hard-coded and never trusted from the request itself.
function verifyWebhookChallenge(query) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') {
        return { ok: false, challenge: null };
    }
    if (!env.metaWhatsappVerifyToken || !timingSafeEqualStrings(token, env.metaWhatsappVerifyToken)) {
        return { ok: false, challenge: null };
    }
    return { ok: true, challenge };
}

// POST webhook payload authenticity - the current Meta requirement: compute HMAC-SHA256 of the RAW request
// body using the app secret, compare against the `X-Hub-Signature-256: sha256=<hex>` header. Must use the raw
// bytes (see app.js's express.json `verify` callback, which stashes them on req.rawBody) - the re-serialized
// parsed body is not guaranteed to be byte-identical to what Meta actually signed (whitespace, key order,
// unicode escaping can all differ). Comparison is constant-time to avoid a timing side-channel. Never logs the
// secret, the header, or the body.
function verifyWebhook(req) {
    const header = req.headers['x-hub-signature-256'];



    if (typeof header !== 'string' || !header.startsWith('sha256=')) {
        return false; // missing/malformed signature - fail closed, never "verify anyway"
    }
    if (!req.rawBody || !env.metaWhatsappAppSecret) {
        return false;
    }

    const expected = `sha256=${crypto.createHmac('sha256', env.metaWhatsappAppSecret).update(req.rawBody).digest('hex')}`;

    return timingSafeEqualStrings(header, expected);
}

// Meta's real webhook payload -> the exact same normalized envelope the mock provider already produces. The
// conversational assistant and messagingAssistantService.js never see Meta's own nested entry/changes/value
// shape - only { provider, channel, sender, message, timestamp }.
//
// Returns null when the payload has nothing actionable for the assistant (e.g. a delivery-status/read-receipt
// callback rather than a new inbound message) - the caller must acknowledge with 200 and do nothing further,
// not treat this as an error.
function normalizeInbound(body) {
    const entry = Array.isArray(body.entry) ? body.entry[0] : null;
    const change = entry && Array.isArray(entry.changes) ? entry.changes[0] : null;
    const value = change ? change.value : null;

    if (!value || !Array.isArray(value.messages) || value.messages.length === 0) {
        return null;
    }

    const message = value.messages[0];
    const isSupportedText = message.type === SUPPORTED_TEXT_TYPE && message.text && typeof message.text.body === 'string';

    return {
        provider: 'meta',
        channel: CHANNEL,
        sender: { externalId: message.from },
        message: {
            id: message.id,
            // Never guessed for anything other than plain text (images/audio/location/stickers/...) - left
            // null so the caller can react generically ("no text") without this file needing to explain why.
            text: isSupportedText ? message.text.body : null,
        },
        timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
    };
}

// Real outbound send via the Cloud API's /messages endpoint (current reference:
// developers.facebook.com/docs/whatsapp/cloud-api/reference/messages).
async function sendMessage({ to, channel, body }) {
    if (channel && channel !== CHANNEL) {
        return { provider: 'meta', accepted: false, channel, error: `Meta WhatsApp cannot send on channel "${channel}"` };
    }
    if (typeof to !== 'string' || to.trim() === '') {
        return { provider: 'meta', accepted: false, channel: CHANNEL, error: 'Missing or invalid recipient address' };
    }
    if (typeof body !== 'string' || body.trim() === '') {
        return { provider: 'meta', accepted: false, channel: CHANNEL, error: 'Message body is required' };
    }
    if (!env.metaWhatsappAccessToken || !env.metaWhatsappPhoneNumberId) {
        return { provider: 'meta', accepted: false, channel: CHANNEL, error: 'Meta WhatsApp is not configured on this server' };
    }

    const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${env.metaWhatsappPhoneNumberId}/messages`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                // The access token is only ever attached here, server-side, as an outbound header - never
                // logged, never echoed in a response, never sent to the frontend.
                Authorization: `Bearer ${env.metaWhatsappAccessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'text',
                text: { body },
            }),
        });

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            // Meta's own error payload can be verbose; only a short, non-sensitive message is surfaced - the
            // request never contained the token in its body, so there is nothing secret to accidentally echo.
            const errorMessage = (data && data.error && data.error.message) || `Meta API responded with HTTP ${response.status}`;
            return { provider: 'meta', accepted: false, channel: CHANNEL, recipient: to, error: errorMessage };
        }

        const messageId = data && Array.isArray(data.messages) && data.messages[0] ? data.messages[0].id : null;
        return { provider: 'meta', accepted: true, channel: CHANNEL, recipient: to, messageId };
    } catch (error) {
        return { provider: 'meta', accepted: false, channel: CHANNEL, recipient: to, error: 'Failed to reach the Meta WhatsApp API' };
    }
}

module.exports = { name: 'meta', verifyWebhookChallenge, verifyWebhook, normalizeInbound, sendMessage };



