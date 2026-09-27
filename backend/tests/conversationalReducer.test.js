const { reduce, HELP_TEXT, UNKNOWN_TEXT, NOTHING_TO_CONFIRM_TEXT, NOTHING_TO_CANCEL_TEXT, CANCELLED_TEXT, MISSING_QUANTITY_TEXT, MISSING_FOOD_ITEM_TEXT, MISSING_DURATION_TEXT } = require('../src/ai/conversationalAssistant/service');
const { INTENTS, UNITS, SESSION_STATES } = require('../src/ai/conversationalAssistant/schemas');

const NOW = new Date('2026-01-01T10:00:00.000Z');
const FUTURE = new Date('2026-01-01T10:05:00.000Z').toISOString();
const PAST = new Date('2026-01-01T09:00:00.000Z').toISOString();

describe('reduce - HELP and UNKNOWN', () => {
    it('HELP returns the help text and never touches an existing session', () => {
        const session = { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.COLLECTING, pendingPayload: { quantity: 4 }, expiresAt: FUTURE };
        const result = reduce({ intent: INTENTS.HELP, entities: null }, session, NOW);
        expect(result.replyText).toBe(HELP_TEXT);
        expect(result.nextSession).toBe(session);
        expect(result.action).toBe('NONE');
    });

    it('UNKNOWN returns a fallback message', () => {
        const result = reduce({ intent: INTENTS.UNKNOWN, entities: null }, null, NOW);
        expect(result.replyText).toBe(UNKNOWN_TEXT);
        expect(result.action).toBe('NONE');
    });
});

describe('reduce - a brand new surplus report', () => {
    it('asks for quantity when missing', () => {
        const result = reduce({ intent: INTENTS.REPORT_SURPLUS, entities: { quantity: null, unit: null, foodItem: 'rice', safeDurationMinutes: 120 } }, null, NOW);
        expect(result.replyText).toBe(MISSING_QUANTITY_TEXT);
        expect(result.nextSession.state).toBe(SESSION_STATES.COLLECTING);
        expect(result.action).toBe('NONE');
    });

    it('asks for the food item when missing', () => {
        const result = reduce({ intent: INTENTS.REPORT_SURPLUS, entities: { quantity: 4, unit: UNITS.BOX, foodItem: null, safeDurationMinutes: 120 } }, null, NOW);
        expect(result.replyText).toBe(MISSING_FOOD_ITEM_TEXT);
        expect(result.nextSession.pendingPayload).toEqual({ quantity: 4, unit: UNITS.BOX, safeDurationMinutes: 120 });
    });

    it('asks for the duration when missing', () => {
        const result = reduce({ intent: INTENTS.REPORT_SURPLUS, entities: { quantity: 4, unit: UNITS.BOX, foodItem: 'rice meals', safeDurationMinutes: null } }, null, NOW);
        expect(result.replyText).toBe(MISSING_DURATION_TEXT);
    });

    it('builds a confirmation summary and moves to AWAITING_CONFIRMATION once everything is present', () => {
        const result = reduce(
            { intent: INTENTS.REPORT_SURPLUS, entities: { quantity: 4, unit: UNITS.BOX, foodItem: 'rice meals', safeDurationMinutes: 120 } },
            null,
            NOW
        );
        expect(result.replyText).toMatch(/Food: rice meals/);
        expect(result.replyText).toMatch(/Quantity: 4 boxes/);
        expect(result.replyText).toMatch(/Safe for: 2 hours/);
        expect(result.replyText).toMatch(/Reply YES to confirm or NO to cancel/);
        expect(result.nextSession.state).toBe(SESSION_STATES.AWAITING_CONFIRMATION);
        expect(result.action).toBe('NONE');
    });
});

describe('reduce - completing a partially-collected report across turns', () => {
    it('merges newly extracted entities onto the still-pending payload', () => {
        const session = {
            intent: INTENTS.REPORT_SURPLUS,
            state: SESSION_STATES.COLLECTING,
            pendingPayload: { quantity: 4, unit: UNITS.BOX },
            expiresAt: FUTURE,
        };
        const result = reduce({ intent: INTENTS.REPORT_SURPLUS, entities: { quantity: null, unit: null, foodItem: 'rice meals', safeDurationMinutes: null } }, session, NOW);
        expect(result.replyText).toBe(MISSING_DURATION_TEXT);
        expect(result.nextSession.pendingPayload).toEqual({ quantity: 4, unit: UNITS.BOX, foodItem: 'rice meals' });
    });

    it('does not carry over a pending payload from an EXPIRED session', () => {
        const expiredSession = {
            intent: INTENTS.REPORT_SURPLUS,
            state: SESSION_STATES.COLLECTING,
            pendingPayload: { quantity: 999, unit: UNITS.KG },
            expiresAt: PAST,
        };
        const result = reduce({ intent: INTENTS.REPORT_SURPLUS, entities: { quantity: 4, unit: UNITS.BOX, foodItem: null, safeDurationMinutes: null } }, expiredSession, NOW);
        expect(result.nextSession.pendingPayload).toEqual({ quantity: 4, unit: UNITS.BOX });
    });

    it('does not carry over a pending payload from a DIFFERENT intent (e.g. a stale AWAITING_CONFIRMATION)', () => {
        const confirmSession = {
            intent: INTENTS.REPORT_SURPLUS,
            state: SESSION_STATES.AWAITING_CONFIRMATION,
            pendingPayload: { quantity: 999, unit: UNITS.KG, foodItem: 'old rice', safeDurationMinutes: 60 },
            expiresAt: FUTURE,
        };
        const result = reduce({ intent: INTENTS.REPORT_SURPLUS, entities: { quantity: 4, unit: null, foodItem: null, safeDurationMinutes: null } }, confirmSession, NOW);
        expect(result.nextSession.pendingPayload).toEqual({ quantity: 4 });
    });
});

describe('reduce - confirmation', () => {
    it('CONFIRM_SURPLUS with a valid AWAITING_CONFIRMATION session triggers CREATE_SURPLUS', () => {
        const session = {
            intent: INTENTS.REPORT_SURPLUS,
            state: SESSION_STATES.AWAITING_CONFIRMATION,
            pendingPayload: { quantity: 4, unit: UNITS.BOX, foodItem: 'rice meals', safeDurationMinutes: 120 },
            expiresAt: FUTURE,
        };
        const result = reduce({ intent: INTENTS.CONFIRM_SURPLUS, entities: null }, session, NOW);
        expect(result.action).toBe('CREATE_SURPLUS');
        expect(result.payload).toEqual(session.pendingPayload);
        expect(result.nextSession).toBeNull();
    });

    it('CONFIRM_SURPLUS with no pending session says there is nothing to confirm', () => {
        const result = reduce({ intent: INTENTS.CONFIRM_SURPLUS, entities: null }, null, NOW);
        expect(result.replyText).toBe(NOTHING_TO_CONFIRM_TEXT);
        expect(result.action).toBe('NONE');
    });

    it('CONFIRM_SURPLUS while still COLLECTING (not yet AWAITING_CONFIRMATION) says there is nothing to confirm', () => {
        const session = { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.COLLECTING, pendingPayload: { quantity: 4 }, expiresAt: FUTURE };
        const result = reduce({ intent: INTENTS.CONFIRM_SURPLUS, entities: null }, session, NOW);
        expect(result.replyText).toBe(NOTHING_TO_CONFIRM_TEXT);
        expect(result.action).toBe('NONE');
    });

    it('CONFIRM_SURPLUS against an EXPIRED confirmation session says there is nothing to confirm', () => {
        const expired = {
            intent: INTENTS.REPORT_SURPLUS,
            state: SESSION_STATES.AWAITING_CONFIRMATION,
            pendingPayload: { quantity: 4, unit: UNITS.BOX, foodItem: 'rice meals', safeDurationMinutes: 120 },
            expiresAt: PAST,
        };
        const result = reduce({ intent: INTENTS.CONFIRM_SURPLUS, entities: null }, expired, NOW);
        expect(result.replyText).toBe(NOTHING_TO_CONFIRM_TEXT);
        expect(result.action).toBe('NONE');
    });

    it('a repeated confirmation after the session was already consumed (cleared) says there is nothing to confirm', () => {
        // Simulates: first "yes" -> action CREATE_SURPLUS, nextSession null (already asserted above).
        // A second "yes" against that same (now-null) session must not create anything a second time.
        const result = reduce({ intent: INTENTS.CONFIRM_SURPLUS, entities: null }, null, NOW);
        expect(result.action).toBe('NONE');
        expect(result.replyText).toBe(NOTHING_TO_CONFIRM_TEXT);
    });
});

describe('reduce - cancellation', () => {
    it('CANCEL with a pending session clears it and confirms cancellation', () => {
        const session = { intent: INTENTS.REPORT_SURPLUS, state: SESSION_STATES.COLLECTING, pendingPayload: { quantity: 4 }, expiresAt: FUTURE };
        const result = reduce({ intent: INTENTS.CANCEL, entities: null }, session, NOW);
        expect(result.replyText).toBe(CANCELLED_TEXT);
        expect(result.nextSession).toBeNull();
    });

    it('CANCEL with nothing pending says so', () => {
        const result = reduce({ intent: INTENTS.CANCEL, entities: null }, null, NOW);
        expect(result.replyText).toBe(NOTHING_TO_CANCEL_TEXT);
    });
});

describe('reduce - list and status', () => {
    it('LIST_SURPLUS defers to the caller via action, with no reply text of its own', () => {
        const result = reduce({ intent: INTENTS.LIST_SURPLUS, entities: null }, null, NOW);
        expect(result.action).toBe('LIST_SURPLUS');
        expect(result.replyText).toBeNull();
    });

    it('SURPLUS_STATUS defers to the caller via action', () => {
        const result = reduce({ intent: INTENTS.SURPLUS_STATUS, entities: null }, null, NOW);
        expect(result.action).toBe('SURPLUS_STATUS');
        expect(result.replyText).toBeNull();
    });
});
