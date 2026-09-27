'use strict';

const { INTENTS } = require('./schemas');
const { detectIntent } = require('./intentDetector');
const { extractSurplusEntities } = require('./entityExtractor');

// WhatsApp's own text messages are capped at 4096 characters, so anything longer never came from a real
// conversation - clamped defensively here (the one funnel point every provider's text passes through) rather
// than trusting each provider's own webhook validator to bound it.
const MAX_TEXT_LENGTH = 4096;

// Combines intent detection and (for REPORT_SURPLUS only) entity extraction into one structured result. Pure
// and deterministic - no I/O, no LLM - so it is fully unit-testable and safe to run on every inbound message.
function parseMessage(text) {
    const bounded = typeof text === 'string' ? text.slice(0, MAX_TEXT_LENGTH) : text;
    const intent = detectIntent(bounded);
    const entities = intent === INTENTS.REPORT_SURPLUS ? extractSurplusEntities(bounded) : null;
    return { intent, entities, rawText: bounded };
}

module.exports = { parseMessage };
