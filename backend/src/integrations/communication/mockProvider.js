'use strict';

const crypto = require('crypto');

// Deterministic mock communication provider: NEVER sends anything externally. It exists so the rescue
// notification feature is fully exercisable in local development, automated tests and an offline SIH demo
// without any WhatsApp/SMS credentials. A real provider (WhatsApp Cloud API, Twilio, ...) would implement this
// exact { name, sendMessage } shape and be selected via COMMUNICATION_PROVIDER instead - see provider.js.

const SUPPORTED_CHANNELS = ['whatsapp', 'sms'];

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {{to: string, channel: 'whatsapp'|'sms', body: string}} message
 * @returns {{provider: 'mock', accepted: boolean, channel: string|null, messageId?: string, error?: string}}
 */
function sendMessage({ to, channel, body }) {
    if (typeof to !== 'string' || to.trim() === '') {
        return { provider: 'mock', accepted: false, channel: channel || null, error: 'Missing or invalid recipient address' };
    }
    if (!SUPPORTED_CHANNELS.includes(channel)) {
        return { provider: 'mock', accepted: false, channel: channel || null, error: `Unsupported channel: must be one of ${SUPPORTED_CHANNELS.join(', ')}` };
    }
    if (typeof body !== 'string' || body.trim() === '') {
        return { provider: 'mock', accepted: false, channel, error: 'Message body is required' };
    }

    // Deterministic, not random: the same {to, channel, body} always yields the same id, so tests never flake
    // and a duplicate send is easy to spot. A real provider's id would instead come back from its own API call.
    const messageId = `mock-${sha256Hex(`${to}|${channel}|${body}`).slice(0, 16)}`;

    return { provider: 'mock', accepted: true, channel, messageId };
}

module.exports = { name: 'mock', sendMessage, SUPPORTED_CHANNELS };
