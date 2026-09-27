'use strict';

// Provider registry - the abstraction that keeps the rest of the app ("resolve a webhook, reply to a
// sender") from knowing or caring which messaging provider is behind it. Today only 'mock' exists; a real
// MetaWhatsAppProvider would register itself here under its own name and implement the same
// { name, verifyWebhook(req), normalizeInbound(rawBody), sendMessage({to, channel, body}) } shape as
// mockProvider.js - only Meta's own webhook verification, message parsing and send-message call would need
// to be written; the conversational/business logic never changes.
const PROVIDERS = {
    mock: require('./mockProvider'),
    meta: require('./metaProvider'),
};

function getProvider(name) {
    const provider = PROVIDERS[name];
    if (!provider) {
        throw new Error(`Unknown messaging provider: ${name}`);
    }
    return provider;
}

module.exports = { getProvider, PROVIDERS };
