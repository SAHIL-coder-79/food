'use strict';

const { getProvider } = require('./provider');
const env = require('../../config/env');

// The one place that decides whether a message actually gets attempted at all. COMMUNICATION_ENABLED defaults
// to false (see config/env.js) so a fresh clone, CI run, or offline SIH demo never needs real credentials and
// never silently tries to reach the network. When disabled, this is a safe, explicit no-op - never an error -
// so callers (services/rescueNotificationService.js) can treat "disabled" as just another delivery outcome.
function sendMessage({ to, channel, body }) {
    if (!env.communicationEnabled) {
        return { provider: null, accepted: false, channel: channel || null, disabled: true, error: 'Communication is disabled (COMMUNICATION_ENABLED=false)' };
    }

    try {
        const provider = getProvider(env.communicationProvider);
        const result = provider.sendMessage({ to, channel, body });
        return { disabled: false, ...result };
    } catch (error) {
        // A provider failure (unknown provider, thrown error, etc.) is reported back, never thrown further -
        // the caller decides how to log/surface it, but a rescue domain operation must never fail because of it.
        return { provider: env.communicationProvider, accepted: false, channel: channel || null, disabled: false, error: error.message };
    }
}

module.exports = { sendMessage };
