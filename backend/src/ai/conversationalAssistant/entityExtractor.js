'use strict';

const { UNITS } = require('./schemas');

// Deterministic entity extraction for a REPORT_SURPLUS message - regex-based, no LLM. Never invents a value:
// a field this can't confidently find comes back null/undefined, and the caller (ai/conversationalAssistant/
// service.js) is responsible for asking the user rather than guessing.

// Quantity + unit are extracted TOGETHER, anchored on the number, so a stray "g"/"l" elsewhere in the message
// (e.g. inside an unrelated word) can never be mistaken for a unit - the unit token must immediately follow
// the number. Longer/more specific spellings are listed before their short forms so the regex engine prefers
// them at the same match position (e.g. "litres" over a bare "l").
const QUANTITY_UNIT_RE =
    /(\d+(?:\.\d+)?)\s*(kilograms?|kgs?|grams?|g|litres?|liters?|l|boxes?|packs?|portions?|meals?|trays?|containers?|units?)\b/i;

// "good for"/"safe for" are captured and removed as a whole phrase, not just the number+unit, so they don't
// leak into the extracted food-item text (e.g. leaving a dangling "good for" behind).
const DURATION_RE =
    /(?:good\s+for|safe\s+for|for\s+(?:the\s+)?next|for)\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;

const FILLER_RE =
    /\b(we\s+have|we've\s+got|we\s+got|there\s+(?:is|are)|i\s+have|left\s*over|leftover|left|remaining|remains?|of|still\s+have)\b/gi;

function canonicalUnit(token) {
    const t = token.toLowerCase();
    if (/^(kilograms?|kgs?)$/.test(t)) return UNITS.KG;
    if (/^(grams?|g)$/.test(t)) return UNITS.GRAM;
    if (/^litres?$/.test(t)) return UNITS.LITRE;
    if (/^liters?$/.test(t)) return UNITS.LITER;
    if (/^l$/.test(t)) return UNITS.LITRE;
    if (/^boxes?$/.test(t)) return UNITS.BOX;
    if (/^packs?$/.test(t)) return UNITS.PACK;
    if (/^portions?$/.test(t)) return UNITS.PORTION;
    if (/^meals?$/.test(t)) return UNITS.MEAL;
    if (/^trays?$/.test(t)) return UNITS.TRAY;
    if (/^containers?$/.test(t)) return UNITS.CONTAINER;
    if (/^units?$/.test(t)) return UNITS.UNIT;
    return null;
}

// Units that already describe WHAT the food is (a "meal" or "portion" needs no further description), versus
// container/measure units (a "box" or "kg" could hold anything, so a food item is still required).
const SELF_DESCRIBING_UNITS = new Set([UNITS.MEAL, UNITS.PORTION]);

function extractSurplusEntities(text) {
    const original = text || '';
    let working = original;

    let quantity = null;
    let unit = null;
    // Duration is extracted BEFORE quantity/unit, deliberately: on a duration-only follow-up turn (e.g. just
    // "good for 2 hours", answering "how long is it safe to keep?"), there is no quantity+unit pair to match,
    // and the generic bare-number fallback below would otherwise wrongly steal the "2" from "2 hours" as if
    // it were a freshly reported quantity.
    let safeDurationMinutes = null;
    const durationMatch = DURATION_RE.exec(working);
    if (durationMatch) {
        const value = Number(durationMatch[1]);
        const durationUnit = durationMatch[2].toLowerCase();
        safeDurationMinutes = durationUnit.startsWith('h') ? Math.round(value * 60) : Math.round(value);
        working = working.slice(0, durationMatch.index) + working.slice(durationMatch.index + durationMatch[0].length);
    }

    const quantityMatch = QUANTITY_UNIT_RE.exec(working);
    if (quantityMatch) {
        quantity = Number(quantityMatch[1]);
        unit = canonicalUnit(quantityMatch[2]);
        working = working.slice(0, quantityMatch.index) + working.slice(quantityMatch.index + quantityMatch[0].length);
    } else {
        // No unit recognised alongside it, but a bare quantity may still be present (e.g. "we have 20 left").
        const bareNumber = /\b(\d+(?:\.\d+)?)\b/.exec(working);
        if (bareNumber) {
            quantity = Number(bareNumber[1]);
            working = working.slice(0, bareNumber.index) + working.slice(bareNumber.index + bareNumber[0].length);
        }
    }

    let foodItem = working
        .replace(FILLER_RE, ' ')
        .replace(/[,.!]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!foodItem && unit && SELF_DESCRIBING_UNITS.has(unit)) {
        foodItem = unit === UNITS.MEAL ? 'meals' : 'portions';
    }

    return {
        quantity,
        unit,
        foodItem: foodItem || null,
        safeDurationMinutes,
        notes: null,
    };
}

module.exports = { extractSurplusEntities, canonicalUnit, SELF_DESCRIBING_UNITS };
