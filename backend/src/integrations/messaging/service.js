'use strict';

const { getProvider } = require('./provider');
const env = require('../../config/env');

// The one place that decides whether an outbound reply actually gets attempted at all. MESSAGING_ENABLED
// defaults to false (see config/env.js) so a fresh clone/CI run/offline demo never needs real credentials.
// When disabled, this is a safe, explicit no-op - never an error - so the conversational assistant can still
// run its full parsing/confirmation/creation flow and simply not attempt real delivery of the reply text.
// async because a real provider's sendMessage (e.g. metaProvider.js) makes a genuine HTTP call. The try/catch
// wraps an `await`, so this function itself can never reject - callers (messagingAssistantService.js) can
// safely fire-and-forget it without an unhandled-rejection risk, matching Task 21 Part 13's "fast webhook
// acknowledgement" choice: the outbound reply send is never on the webhook's own response critical path.
async function sendMessage({ to, channel, body }) {
    if (!env.messagingEnabled) {
        return { provider: null, accepted: false, channel: channel || null, disabled: true, error: 'Messaging is disabled (MESSAGING_ENABLED=false)' };
    }
    try {
        const provider = getProvider(env.messagingProvider);
        const result = await provider.sendMessage({ to, channel, body });
        return { disabled: false, ...result };
    } catch (error) {
        return { provider: env.messagingProvider, accepted: false, channel: channel || null, disabled: false, error: error.message };
    }
}

// Webhook verification always runs, regardless of MESSAGING_ENABLED - it's about trusting who is calling the
// inbound endpoint, not about whether the app is allowed to send messages out.
function verifyWebhook(providerName, req) {
    const provider = getProvider(providerName);
    return Boolean(provider.verifyWebhook(req));
}

// The GET /webhook subscription handshake (Meta-specific in practice; the mock provider always answers "not
// applicable"). Always checked against whichever provider is actually configured (env.messagingProvider),
// never a value supplied by the request itself.
function verifyWebhookChallenge(providerName, query) {
    const provider = getProvider(providerName);
    if (typeof provider.verifyWebhookChallenge !== 'function') {
        return { ok: false, challenge: null };
    }
    return provider.verifyWebhookChallenge(query);
}

function normalizeInbound(providerName, body) {
    const provider = getProvider(providerName);
    return provider.normalizeInbound(body);
}

module.exports = { sendMessage, verifyWebhook, verifyWebhookChallenge, normalizeInbound };
