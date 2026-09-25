'use strict';

// Provider registry - the abstraction that keeps the rest of the app ("send a rescue notification") from
// knowing or caring which communication provider is behind it. Today only 'mock' exists; a real WhatsApp
// Cloud API / Twilio / other SMS provider would register itself here under its own name and implement the
// same { name, sendMessage({to, channel, body}) } shape as mockProvider.js.
const PROVIDERS = {
    mock: require('./mockProvider'),
};

function getProvider(name) {
    const provider = PROVIDERS[name];
    if (!provider) {
        throw new Error(`Unknown communication provider: ${name}`);
    }
    return provider;
}

module.exports = { getProvider, PROVIDERS };
