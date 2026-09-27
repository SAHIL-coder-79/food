const { detectIntent } = require('../src/ai/conversationalAssistant/intentDetector');
const { extractSurplusEntities } = require('../src/ai/conversationalAssistant/entityExtractor');
const { parseMessage } = require('../src/ai/conversationalAssistant/parser');
const { INTENTS, UNITS } = require('../src/ai/conversationalAssistant/schemas');

describe('intentDetector', () => {
    it('detects REPORT_SURPLUS for messages describing a quantity', () => {
        expect(detectIntent('We have 4 boxes of rice meals left')).toBe(INTENTS.REPORT_SURPLUS);
        expect(detectIntent('20 meals remaining')).toBe(INTENTS.REPORT_SURPLUS);
        expect(detectIntent('We have 10 kg cooked rice left')).toBe(INTENTS.REPORT_SURPLUS);
    });

    it('detects CONFIRM_SURPLUS for yes/confirm variants', () => {
        ['yes', 'y', 'Yes!', 'confirm', 'confirmed', 'create it', 'ok', 'okay', 'go ahead'].forEach((text) => {
            expect(detectIntent(text)).toBe(INTENTS.CONFIRM_SURPLUS);
        });
    });

    it('detects CANCEL for no/cancel variants', () => {
        ['no', 'n', 'cancel', 'cancel it', 'stop', 'never mind', 'nevermind'].forEach((text) => {
            expect(detectIntent(text)).toBe(INTENTS.CANCEL);
        });
    });

    it('detects LIST_SURPLUS', () => {
        expect(detectIntent('show my surplus')).toBe(INTENTS.LIST_SURPLUS);
        expect(detectIntent('list my surpluses')).toBe(INTENTS.LIST_SURPLUS);
    });

    it('detects SURPLUS_STATUS', () => {
        expect(detectIntent('status of my surplus')).toBe(INTENTS.SURPLUS_STATUS);
        expect(detectIntent('what is the status of my surplus?')).toBe(INTENTS.SURPLUS_STATUS);
    });

    it('detects HELP', () => {
        expect(detectIntent('help')).toBe(INTENTS.HELP);
        expect(detectIntent('Help!')).toBe(INTENTS.HELP);
    });

    it('falls back to UNKNOWN for unrelated or empty text', () => {
        expect(detectIntent('good morning')).toBe(INTENTS.UNKNOWN);
        expect(detectIntent('')).toBe(INTENTS.UNKNOWN);
        expect(detectIntent('   ')).toBe(INTENTS.UNKNOWN);
    });

    it('never throws on garbage input', () => {
        expect(() => detectIntent(null)).not.toThrow();
        expect(() => detectIntent(undefined)).not.toThrow();
        expect(detectIntent(null)).toBe(INTENTS.UNKNOWN);
    });
});

describe('entityExtractor - quantity and unit', () => {
    it('extracts quantity and unit together from the worked example', () => {
        const result = extractSurplusEntities('We have 4 boxes of rice meals left, good for 2 hours');
        expect(result.quantity).toBe(4);
        expect(result.unit).toBe(UNITS.BOX);
    });

    it('extracts kg correctly', () => {
        const result = extractSurplusEntities('We have 10 kg cooked rice left');
        expect(result.quantity).toBe(10);
        expect(result.unit).toBe(UNITS.KG);
        expect(result.foodItem).toBe('cooked rice');
    });

    it('recognises every documented unit', () => {
        const cases = [
            ['5 meals left', UNITS.MEAL],
            ['5 boxes left', UNITS.BOX],
            ['5 packs left', UNITS.PACK],
            ['5 portions left', UNITS.PORTION],
            ['5 kg left', UNITS.KG],
            ['5 grams left', UNITS.GRAM],
            ['5 litres left', UNITS.LITRE],
            ['5 liters left', UNITS.LITER],
            ['5 trays left', UNITS.TRAY],
            ['5 containers left', UNITS.CONTAINER],
            ['5 units left', UNITS.UNIT],
        ];
        cases.forEach(([text, expectedUnit]) => {
            expect(extractSurplusEntities(text).unit).toBe(expectedUnit);
        });
    });

    it('falls back to a bare quantity when no unit keyword is present', () => {
        const result = extractSurplusEntities('we have 20 left');
        expect(result.quantity).toBe(20);
        expect(result.unit).toBeNull();
    });

    it('returns null quantity when no number is present at all', () => {
        const result = extractSurplusEntities('we have rice left');
        expect(result.quantity).toBeNull();
    });
});

describe('entityExtractor - food item', () => {
    it('extracts the food item from the worked example', () => {
        const result = extractSurplusEntities('We have 4 boxes of rice meals left, good for 2 hours');
        expect(result.foodItem).toBe('rice meals');
    });

    it('defaults a self-describing unit (meal/portion) to itself when no other food text remains', () => {
        expect(extractSurplusEntities('20 meals remaining').foodItem).toBe('meals');
        expect(extractSurplusEntities('5 portions left').foodItem).toBe('portions');
    });

    it('does not invent a food item for a container-type unit with nothing else in the message', () => {
        expect(extractSurplusEntities('4 boxes left').foodItem).toBeNull();
        expect(extractSurplusEntities('10 kg left').foodItem).toBeNull();
    });

    it('strips filler words without mangling the actual food description', () => {
        expect(extractSurplusEntities('there are 6 trays of vegetable biryani remaining').foodItem).toBe('vegetable biryani');
    });
});

describe('entityExtractor - duration', () => {
    it('extracts and converts hours to minutes', () => {
        expect(extractSurplusEntities('4 boxes of rice meals, good for 2 hours').safeDurationMinutes).toBe(120);
        expect(extractSurplusEntities('4 boxes, safe for 1 hour').safeDurationMinutes).toBe(60);
    });

    it('extracts minutes directly', () => {
        expect(extractSurplusEntities('4 boxes, good for 45 minutes').safeDurationMinutes).toBe(45);
    });

    it('returns null when no duration is mentioned', () => {
        expect(extractSurplusEntities('4 boxes of rice meals left').safeDurationMinutes).toBeNull();
    });

    it('handles fractional hours', () => {
        expect(extractSurplusEntities('4 boxes, good for 1.5 hours').safeDurationMinutes).toBe(90);
    });

    it('a duration-only message never lets the duration\'s own number leak into quantity', () => {
        // Regression: extraction order previously ran quantity/unit before duration, so a bare fallback
        // number would steal the "2" out of "good for 2 hours" before duration extraction ever saw it.
        const result = extractSurplusEntities('good for 2 hours');
        expect(result.safeDurationMinutes).toBe(120);
        expect(result.quantity).toBeNull();
    });

    it('same regression check for a minutes-only follow-up', () => {
        const result = extractSurplusEntities('safe for 45 minutes');
        expect(result.safeDurationMinutes).toBe(45);
        expect(result.quantity).toBeNull();
    });
});

describe('entityExtractor - never invents values', () => {
    // extractSurplusEntities is only ever called on text the intent detector already gated as REPORT_SURPLUS
    // (i.e. containing a digit - see parser.js), so a realistic "found nothing useful" input still has one.
    it('never fabricates a unit, food item or duration for a bare, contextless number', () => {
        const result = extractSurplusEntities('123');
        expect(result.quantity).toBe(123);
        expect(result.unit).toBeNull();
        expect(result.foodItem).toBeNull();
        expect(result.safeDurationMinutes).toBeNull();
    });
});

describe('parser.parseMessage', () => {
    it('combines intent and entities for a REPORT_SURPLUS message', () => {
        const result = parseMessage('We have 4 boxes of rice meals left, good for 2 hours');
        expect(result.intent).toBe(INTENTS.REPORT_SURPLUS);
        expect(result.entities).toEqual({ quantity: 4, unit: UNITS.BOX, foodItem: 'rice meals', safeDurationMinutes: 120, notes: null });
    });

    it('does not attempt entity extraction for non-report intents', () => {
        expect(parseMessage('yes').entities).toBeNull();
        expect(parseMessage('help').entities).toBeNull();
        expect(parseMessage('cancel').entities).toBeNull();
    });
});
