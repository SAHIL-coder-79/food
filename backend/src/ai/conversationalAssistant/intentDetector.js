'use strict';

const { INTENTS } = require('./schemas');

// Deterministic, rule-based intent detection - no LLM. Order matters: short, near-exact conversational replies
// (yes/no/help/list/status) are checked FIRST, since they are unambiguous; REPORT_SURPLUS is only inferred
// when the message actually looks like a quantity report (a number is present). Anything else is UNKNOWN.

const CONFIRM_RE = /^\s*(yes|y|yeah|yep|confirm(ed)?|create it|ok(ay)?|go ahead|sure)\s*[.!]?\s*$/i;
const CANCEL_RE = /^\s*(no|n|nope|cancel( it)?|stop|never\s*mind|nevermind|discard)\s*[.!]?\s*$/i;
const HELP_RE = /^\s*(help|what can you do|commands?)\s*[?.!]?\s*$/i;
const LIST_RE = /\b(show|list|view)\b[\s\S]*\bsurplus(es)?\b|\bmy\s+surplus(es)?\b/i;
const STATUS_RE = /\bstatus\b[\s\S]*\bsurplus(es)?\b|\bsurplus(es)?\b[\s\S]*\bstatus\b/i;
// A report needs at least one number (a quantity) - "we have rice left" alone is too vague to count as a report.
const REPORT_HINT_RE = /\d/;

function detectIntent(text) {
    const trimmed = (text || '').trim();
    if (trimmed === '') return INTENTS.UNKNOWN;

    if (HELP_RE.test(trimmed)) return INTENTS.HELP;
    if (CONFIRM_RE.test(trimmed)) return INTENTS.CONFIRM_SURPLUS;
    if (CANCEL_RE.test(trimmed)) return INTENTS.CANCEL;
    if (STATUS_RE.test(trimmed)) return INTENTS.SURPLUS_STATUS;
    if (LIST_RE.test(trimmed)) return INTENTS.LIST_SURPLUS;
    if (REPORT_HINT_RE.test(trimmed)) return INTENTS.REPORT_SURPLUS;

    return INTENTS.UNKNOWN;
}

module.exports = { detectIntent };
