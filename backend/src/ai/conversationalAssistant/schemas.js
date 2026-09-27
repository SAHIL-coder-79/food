'use strict';

// Shared vocabulary for the FoodShare Conversational Assistant. Deliberately a plain, deterministic set of
// constants - no LLM, no external NLU service. See parser.js/intentDetector.js/entityExtractor.js.

const INTENTS = Object.freeze({
    REPORT_SURPLUS: 'REPORT_SURPLUS',
    CONFIRM_SURPLUS: 'CONFIRM_SURPLUS',
    CANCEL: 'CANCEL',
    LIST_SURPLUS: 'LIST_SURPLUS',
    SURPLUS_STATUS: 'SURPLUS_STATUS',
    HELP: 'HELP',
    UNKNOWN: 'UNKNOWN',
});

// Matches the existing surplus_listings schema's own implicit convention (a bare quantity number, no unit
// column) - see entityExtractor.js's mapToSurplusPayload for how these fold into the existing API's payload.
const UNITS = Object.freeze({
    MEAL: 'MEAL',
    BOX: 'BOX',
    PACK: 'PACK',
    PORTION: 'PORTION',
    KG: 'KG',
    GRAM: 'GRAM',
    LITRE: 'LITRE',
    LITER: 'LITER',
    TRAY: 'TRAY',
    CONTAINER: 'CONTAINER',
    UNIT: 'UNIT',
});

// A pending REPORT_SURPLUS conversation is either still missing required fields (COLLECTING) or has
// everything it needs and is waiting on an explicit yes/no (AWAITING_CONFIRMATION).
const SESSION_STATES = Object.freeze({
    COLLECTING: 'COLLECTING',
    AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
});

module.exports = { INTENTS, UNITS, SESSION_STATES };
