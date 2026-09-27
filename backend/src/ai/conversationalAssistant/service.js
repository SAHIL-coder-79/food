'use strict';

// The pure "conversation reducer": given the parsed message, the previous pending session (if any) and the
// current time, decides what happens next - purely a function of its inputs, no I/O, no clock reads, no
// randomness, so it is fully unit-testable. It NEVER touches the database and NEVER calls the real surplus
// service itself; it only tells its caller (services/messagingAssistantService.js) what to do next via
// `action`. That caller is the only place allowed to actually create a surplus listing.

const { INTENTS, UNITS, SESSION_STATES } = require('./schemas');
const { extractSurplusEntities } = require('./entityExtractor');

const UNIT_LABELS = {
    [UNITS.BOX]: ['box', 'boxes'],
    [UNITS.PACK]: ['pack', 'packs'],
    [UNITS.PORTION]: ['portion', 'portions'],
    [UNITS.MEAL]: ['meal', 'meals'],
    [UNITS.KG]: ['kg', 'kg'],
    [UNITS.GRAM]: ['gram', 'grams'],
    [UNITS.LITRE]: ['litre', 'litres'],
    [UNITS.LITER]: ['liter', 'liters'],
    [UNITS.TRAY]: ['tray', 'trays'],
    [UNITS.CONTAINER]: ['container', 'containers'],
    [UNITS.UNIT]: ['unit', 'units'],
};

function formatUnitLabel(unit, quantity) {
    if (!unit || !UNIT_LABELS[unit]) return '';
    const [singular, plural] = UNIT_LABELS[unit];
    return quantity === 1 ? singular : plural;
}

function formatDuration(minutes) {
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const HELP_TEXT =
    'FoodShare Assistant - what I can do:\n' +
    "- Report surplus: e.g. '4 boxes of rice meals left, good for 2 hours'\n" +
    "- 'show my surplus' - list your active listings\n" +
    "- 'status of my surplus' - a quick summary\n" +
    "- 'yes' / 'confirm' - confirm a pending report\n" +
    "- 'no' / 'cancel' - cancel a pending report\n" +
    "- 'help' - show this message";

const UNKNOWN_TEXT = "Sorry, I didn't understand that. Reply 'help' to see what I can do.";
const NOTHING_TO_CONFIRM_TEXT =
    "There's nothing pending to confirm. Tell me what surplus you'd like to report, e.g. " +
    "'4 boxes of rice meals left, good for 2 hours'.";
const NOTHING_TO_CANCEL_TEXT = 'There is nothing pending to cancel.';
const CANCELLED_TEXT = 'Okay, cancelled. Nothing was created.';
const MISSING_QUANTITY_TEXT = "I can create the surplus, but I need the quantity. Example: '10 meal boxes left.'";
const MISSING_FOOD_ITEM_TEXT = 'Which food item is left?';
const MISSING_DURATION_TEXT = "How long is it safe to keep? Example: 'good for 2 hours'.";

function compact(entities) {
    if (!entities) return {};
    const out = {};
    if (entities.quantity != null) out.quantity = entities.quantity;
    if (entities.unit) out.unit = entities.unit;
    if (entities.foodItem) out.foodItem = entities.foodItem;
    if (entities.safeDurationMinutes != null) out.safeDurationMinutes = entities.safeDurationMinutes;
    return out;
}

function buildConfirmationSummary(payload) {
    const unitLabel = formatUnitLabel(payload.unit, payload.quantity);
    const quantityLine = unitLabel ? `${payload.quantity} ${unitLabel}` : `${payload.quantity}`;
    return (
        'I understood:\n\n' +
        `Food: ${payload.foodItem}\n` +
        `Quantity: ${quantityLine}\n` +
        `Safe for: ${formatDuration(payload.safeDurationMinutes)}\n\n` +
        'Should I create this surplus?\n\n' +
        'Reply YES to confirm or NO to cancel.'
    );
}

function isPending(session, now) {
    return Boolean(session) && new Date(session.expiresAt).getTime() > now.getTime();
}

/**
 * @param {{intent: string, entities: object|null, rawText?: string}} parsed
 * @param {{intent: string, state: string, pendingPayload: object, expiresAt: string|Date}|null} session
 * @param {Date} now
 * @returns {{replyText: string|null, nextSession: {intent:string, state:string, pendingPayload:object}|null, action: 'NONE'|'CREATE_SURPLUS'|'LIST_SURPLUS'|'SURPLUS_STATUS'}}
 */
function reduce({ intent, entities, rawText }, session, now) {
    const pending = isPending(session, now) ? session : null;

    // A plain-text reply to "which food item is left?" (e.g. just "rice meals") has no number in it, so the
    // standalone intent detector correctly can't call it a fresh REPORT_SURPLUS on its own. But in the middle
    // of an already-open, still-COLLECTING report, any message that isn't itself a recognised command (yes/
    // no/help/list/status) is almost certainly the user answering the pending question, not a non-sequitur -
    // so it is treated as a continuation, re-extracting entities from the raw text for this turn.
    let intentForTurn = intent;
    let entitiesForTurn = entities;
    if (intent === INTENTS.UNKNOWN && pending && pending.intent === INTENTS.REPORT_SURPLUS && pending.state === SESSION_STATES.COLLECTING) {
        intentForTurn = INTENTS.REPORT_SURPLUS;
        entitiesForTurn = extractSurplusEntities(rawText || '');
    }

    if (intentForTurn === INTENTS.HELP) {
        return { replyText: HELP_TEXT, nextSession: pending, action: 'NONE' };
    }

    if (intentForTurn === INTENTS.CANCEL) {
        if (pending) return { replyText: CANCELLED_TEXT, nextSession: null, action: 'NONE' };
        return { replyText: NOTHING_TO_CANCEL_TEXT, nextSession: null, action: 'NONE' };
    }

    if (intentForTurn === INTENTS.CONFIRM_SURPLUS) {
        if (!pending || pending.state !== SESSION_STATES.AWAITING_CONFIRMATION) {
            return { replyText: NOTHING_TO_CONFIRM_TEXT, nextSession: null, action: 'NONE' };
        }
        return { replyText: null, nextSession: null, action: 'CREATE_SURPLUS', payload: pending.pendingPayload };
    }

    if (intentForTurn === INTENTS.LIST_SURPLUS) {
        return { replyText: null, nextSession: pending, action: 'LIST_SURPLUS' };
    }

    if (intentForTurn === INTENTS.SURPLUS_STATUS) {
        return { replyText: null, nextSession: pending, action: 'SURPLUS_STATUS' };
    }

    if (intentForTurn === INTENTS.REPORT_SURPLUS) {
        const carryOver = pending && pending.intent === INTENTS.REPORT_SURPLUS && pending.state === SESSION_STATES.COLLECTING
            ? pending.pendingPayload
            : {};
        const merged = { ...carryOver, ...compact(entitiesForTurn) };

        if (merged.quantity == null) {
            return {
                replyText: MISSING_QUANTITY_TEXT,
                nextSession: { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.COLLECTING, pendingPayload: merged },
                action: 'NONE',
            };
        }
        if (!merged.foodItem) {
            return {
                replyText: MISSING_FOOD_ITEM_TEXT,
                nextSession: { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.COLLECTING, pendingPayload: merged },
                action: 'NONE',
            };
        }
        if (merged.safeDurationMinutes == null) {
            return {
                replyText: MISSING_DURATION_TEXT,
                nextSession: { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.COLLECTING, pendingPayload: merged },
                action: 'NONE',
            };
        }

        return {
            replyText: buildConfirmationSummary(merged),
            nextSession: { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.AWAITING_CONFIRMATION, pendingPayload: merged },
            action: 'NONE',
        };
    }

    // UNKNOWN
    return { replyText: UNKNOWN_TEXT, nextSession: pending, action: 'NONE' };
}

module.exports = {
    reduce,
    buildConfirmationSummary,
    formatUnitLabel,
    formatDuration,
    HELP_TEXT,
    UNKNOWN_TEXT,
    NOTHING_TO_CONFIRM_TEXT,
    NOTHING_TO_CANCEL_TEXT,
    CANCELLED_TEXT,
    MISSING_QUANTITY_TEXT,
    MISSING_FOOD_ITEM_TEXT,
    MISSING_DURATION_TEXT,
};
