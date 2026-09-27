'use strict';

// The FoodShare Conversational Assistant's domain orchestrator. This is the ONLY place that connects an
// inbound message to real FoodShare state - it resolves the sender through the server-side identity mapping,
// runs the pure parser/reducer, and for an actual surplus report calls the EXISTING, unmodified
// surplusListingService.createListing - the same function the web UI's "Publish Listing" button calls. No
// business rule (ownership, validation, spoilage assessment, notifications, NGO matching...) is duplicated
// here; this file only ever decides WHAT to call and WHAT to say back.

const messagingIdentityModel = require('../models/messagingIdentityModel');
const conversationSessionModel = require('../models/conversationSessionModel');
const messagingInboundLogModel = require('../models/messagingInboundLogModel');
const userModel = require('../models/userModel');
const surplusListingService = require('./surplusListingService');
const messagingService = require('../integrations/messaging/service');
const messagingIdentityService = require('./messagingIdentityService');
const parser = require('../ai/conversationalAssistant/parser');
const conversationReducer = require('../ai/conversationalAssistant/service');
const { UNITS, SESSION_STATES } = require('../ai/conversationalAssistant/schemas');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const { KITCHEN_ROLES, LISTING_STATUS } = require('../utils/constants');

const NOT_LINKED_TEXT =
    'Your WhatsApp number is not linked to a FoodShare kitchen account. Please contact your FoodShare administrator, ' +
    'or ask them to generate a linking code and send it to this number to link it yourself.';
const ACCOUNT_INACTIVE_TEXT = 'Your linked FoodShare account is not active. Please contact your FoodShare administrator.';
const KITCHEN_ONLY_TEXT = 'This assistant is available to kitchen accounts only.';
const CREATE_FAILED_GENERIC_TEXT =
    "Sorry, I couldn't create that surplus - some information was missing or invalid. Please start again, e.g. " +
    "'4 boxes of rice meals left, good for 2 hours'.";
const LINK_INVALID_TEXT = "That linking code isn't valid or has expired. Ask your FoodShare administrator for a new one.";
const LINK_ALREADY_LINKED_TEXT = 'This WhatsApp number is already linked to a FoodShare account.';
const UNSUPPORTED_MESSAGE_TYPE_TEXT = 'I currently support text messages. Please send your FoodShare request as text.';

// Recognises "FS-ABC123" (Task 21's linking-code format from services/messagingIdentityService.js), with or
// without a leading "link"/"link:" - checked ONLY for a sender with no existing identity (see
// handleInboundMessage), so it can never be mistaken for part of an ordinary surplus report.
const LINK_CODE_RE = /^\s*(?:link\s*[:-]?\s*)?(FS-[A-Z0-9]{6})\s*$/i;

function extractLinkCode(text) {
    const match = LINK_CODE_RE.exec((text || '').trim());
    return match ? match[1].toUpperCase() : null;
}

// A "box"/"pack"/"meal"/etc. describes a CONTAINER, not the food inside it, so it is folded into foodType
// alongside the food description. KG/GRAM/LITRE/LITER already match the existing surplus_listings schema's
// own implicit convention (a bare quantity number with no unit column - the web UI hard-codes "kg" wherever
// it displays quantity), so those are left off entirely rather than adding a mismatched unit annotation.
const CONTAINER_UNITS = new Set([UNITS.BOX, UNITS.PACK, UNITS.PORTION, UNITS.MEAL, UNITS.TRAY, UNITS.CONTAINER, UNITS.UNIT]);

function mapToFoodType(foodItem, unit, quantity) {
    if (unit && CONTAINER_UNITS.has(unit)) {
        const unitLabel = conversationReducer.formatUnitLabel(unit, quantity);
        return unitLabel ? `${foodItem} (${unitLabel})` : foodItem;
    }
    return foodItem;
}

// Re-validates the pending payload from scratch rather than trusting whatever the parser produced earlier in
// the conversation (Task 20 Part 7: "Never trust the original parsed payload blindly. Validate it again
// server-side."), then calls the EXISTING surplus creation service - the single integration seam with the
// real business logic (spoilage assessment, notifications, everything downstream).
//
// Returns { replyText, listing } - `listing` is the real, freshly-created surplus_listings row on success, or
// null on any failure. Callers use `listing` only to enrich a response (e.g. the dev test endpoint's
// `listingId`/`surplus` fields); the reply text alone is what a real messaging channel actually delivers.
async function performSurplusCreation(actingUser, payload) {
    const quantity = Number(payload.quantity);
    const foodItem = typeof payload.foodItem === 'string' ? payload.foodItem.trim() : '';
    const safeDurationMinutes = Number(payload.safeDurationMinutes);

    if (!Number.isFinite(quantity) || quantity <= 0 || !foodItem || !Number.isFinite(safeDurationMinutes) || safeDurationMinutes <= 0) {
        return { replyText: CREATE_FAILED_GENERIC_TEXT, listing: null };
    }

    const foodType = mapToFoodType(foodItem, payload.unit, quantity);
    const safeUntilTime = new Date(Date.now() + safeDurationMinutes * 60 * 1000).toISOString();

    try {
        const { listing } = await surplusListingService.createListing(actingUser, { quantity, foodType, safeUntilTime });
        const unitLabel = conversationReducer.formatUnitLabel(payload.unit, quantity);
        const quantityLine = unitLabel ? `${quantity} ${unitLabel}` : `${quantity}`;
        const replyText =
            `✅ Surplus created (listing #${listing.id}).\n\n` +
            `${quantityLine} of ${foodItem}\n` +
            `Safe for: ${conversationReducer.formatDuration(safeDurationMinutes)}\n\n` +
            'FoodShare has added it to the rescue workflow.';
        return { replyText, listing };
    } catch (error) {
        // The same error a kitchen staff member would see from the web form - safe to echo verbatim.
        if (error instanceof AppError) {
            return { replyText: `Sorry, I couldn't create that surplus: ${error.message}`, listing: null };
        }
        throw error;
    }
}

// Shapes a pending REPORT_SURPLUS payload for a caller that wants structured fields (the dev test endpoint),
// not just the human-readable confirmation text. Never invents a value: a field the payload doesn't have yet
// comes back null, exactly like the underlying entity extractor's own convention.
function toPendingActionView(payload) {
    // Reuses the existing pluralization helper (already used to build the human-readable confirmation text)
    // rather than a raw lowercase, so "20 boxes" reads naturally instead of the enum's singular "box".
    const unitLabel = payload.unit ? conversationReducer.formatUnitLabel(payload.unit, payload.quantity ?? 0) : null;
    return {
        type: 'CREATE_SURPLUS',
        quantity: payload.quantity ?? null,
        unit: unitLabel || null,
        foodItem: payload.foodItem ?? null,
        safeForHours: payload.safeDurationMinutes != null ? Math.round((payload.safeDurationMinutes / 60) * 100) / 100 : null,
    };
}

async function buildSurplusListText(actingUser) {
    const listings = await surplusListingService.listOwnListings(actingUser, {});
    const active = listings.filter((l) => l.status === LISTING_STATUS.AVAILABLE || l.status === LISTING_STATUS.CLAIMED);
    if (active.length === 0) return 'You have no active surplus listings right now.';
    const lines = active.slice(0, 10).map((l) => `#${l.id} - ${l.food_type} (${l.status})`);
    return `Your active surplus:\n\n${lines.join('\n')}`;
}

async function buildSurplusStatusText(actingUser) {
    const listings = await surplusListingService.listOwnListings(actingUser, {});
    const count = (status) => listings.filter((l) => l.status === status).length;
    return (
        `Surplus status: ${count(LISTING_STATUS.AVAILABLE)} available, ` +
        `${count(LISTING_STATUS.CLAIMED)} claimed, ${count(LISTING_STATUS.COLLECTED)} collected.`
    );
}

/**
 * Processes one normalized inbound message end to end. Returns { duplicate, reply, stage, pendingAction,
 * listing }. `stage`/`pendingAction`/`listing` are additive, structured detail for a caller that wants more
 * than the human-readable reply text (the dev test endpoint) - `duplicate`/`reply` are the original Task 20
 * contract and remain unchanged for the real webhook and every existing caller/test.
 *
 * Never throws for an ordinary conversational outcome (unknown sender, missing fields, business validation
 * failure) - only an unexpected infrastructure error propagates, exactly like any other FoodShare API call.
 */
async function handleInboundMessage(normalized) {
    const { provider, channel, sender, message } = normalized;

    // Best-effort outbound delivery (Task 21 Part 13: never on the webhook's own response-time critical
    // path - messagingService.sendMessage never rejects, so this is safe to fire-and-forget). Centralized here
    // so every reply path - including the early "not linked"/"inactive"/"unsupported type" ones that Task 20
    // never actually delivered anywhere - genuinely reaches the real provider, not just the HTTP response body
    // (which matters once a real provider, not only the dev/test simulator, is reading it).
    const respond = (replyText, { duplicate = false, stage = 'ok', pendingAction = null, listing = null } = {}) => {
        if (!duplicate) {
            messagingService.sendMessage({ to: sender.externalId, channel, body: replyText });
        }
        return { duplicate, reply: replyText, stage, pendingAction, listing };
    };

    const identity = await messagingIdentityModel.findByExternalContact(provider, channel, sender.externalId);

    try {
        await messagingInboundLogModel.record({
            provider,
            channel,
            externalMessageId: message.id,
            messagingIdentityId: identity ? identity.id : null,
        });
    } catch (error) {
        if (error && error.code === '23505') {
            // Redelivery of a message we've already handled - do nothing a second time (Task 20 Part 11).
            return respond(null, { duplicate: true, stage: 'duplicate' });
        }
        throw error;
    }

    // Checked for EVERY sender, linked or not - not only unknown ones. If this were checked only inside the
    // "unknown sender" branch, a valid code freshly generated for a different account but sent from a number
    // that is ALREADY linked to someone else would silently fall through to ordinary conversation parsing
    // instead of a clear refusal - not a real hijack (nothing would be reassigned), but a confusing dead end
    // where a legitimate takeover ATTEMPT goes unexplained. Checking here first makes the refusal explicit.
    const code = extractLinkCode(message.text);
    if (code) {
        const result = await messagingIdentityService.completeLinkFromCode({ code, provider, channel, externalUserId: sender.externalId });
        if (result.ok) {
            return respond(
                "✅ This WhatsApp number is now linked to your FoodShare account. You can report surplus here, e.g. " +
                    "'4 boxes of rice meals left, good for 2 hours'.",
                { stage: 'linked' }
            );
        }
        return respond(result.reason === 'already_linked' ? LINK_ALREADY_LINKED_TEXT : LINK_INVALID_TEXT, {
            stage: result.reason === 'already_linked' ? 'link_already_linked' : 'link_invalid',
        });
    }

    if (!identity || !identity.active) {
        return respond(NOT_LINKED_TEXT, { stage: 'not_linked' });
    }

    const user = await userModel.findById(identity.userId);
    // Defense in depth: the identity's own stored organizationId must still agree with the live user record -
    // if a user's organization was ever changed, the identity link is treated as no longer trustworthy rather
    // than silently acting on stale data.
    if (!user || !user.is_active || user.organization_id !== identity.organizationId) {
        return respond(ACCOUNT_INACTIVE_TEXT, { stage: 'account_inactive' });
    }
    if (!KITCHEN_ROLES.includes(user.role)) {
        return respond(KITCHEN_ONLY_TEXT, { stage: 'kitchen_only' });
    }

    // A non-text message (image/audio/location/sticker/...) - Task 21 Part 4: never guess what it means. This
    // is decided generically (is there text or not), so this file never needs to know WHICH provider or WHY.
    if (!message.text) {
        return respond(UNSUPPORTED_MESSAGE_TYPE_TEXT, { stage: 'unsupported_type' });
    }

    // The exact same shape authenticate.js attaches to req.user for a normal JWT-authenticated request - this
    // is what lets the existing surplusListingService be called completely unchanged.
    const actingUser = { id: user.id, organizationId: user.organization_id, role: user.role };

    const parsed = parser.parseMessage(message.text);
    const existingSession = await conversationSessionModel.findByIdentityId(identity.id);
    const now = new Date();
    const decision = conversationReducer.reduce(parsed, existingSession, now);

    let replyText = decision.replyText;
    let stage = 'ok';
    let pendingAction = null;
    let createdListing = null;

    if (decision.action === 'CREATE_SURPLUS') {
        const outcome = await performSurplusCreation(actingUser, decision.payload);
        replyText = outcome.replyText;
        createdListing = outcome.listing;
        stage = outcome.listing ? 'created' : 'creation_failed';
    } else if (decision.action === 'LIST_SURPLUS') {
        replyText = await buildSurplusListText(actingUser);
        stage = 'listed';
    } else if (decision.action === 'SURPLUS_STATUS') {
        replyText = await buildSurplusStatusText(actingUser);
        stage = 'status';
    } else if (decision.nextSession && decision.nextSession.state === SESSION_STATES.AWAITING_CONFIRMATION) {
        stage = 'awaiting_confirmation';
        pendingAction = toPendingActionView(decision.nextSession.pendingPayload);
    } else if (decision.nextSession && decision.nextSession.state === SESSION_STATES.COLLECTING) {
        stage = 'collecting';
        pendingAction = toPendingActionView(decision.nextSession.pendingPayload);
    } else {
        // No session change and no domain action - a HELP/CANCEL/CONFIRM-with-nothing-pending/UNKNOWN reply.
        const STAGE_BY_INTENT = { HELP: 'help', CANCEL: 'cancelled', CONFIRM_SURPLUS: 'nothing_to_confirm', UNKNOWN: 'unknown' };
        stage = STAGE_BY_INTENT[parsed.intent] || 'ok';
    }

    if (decision.nextSession) {
        await conversationSessionModel.upsert({
            messagingIdentityId: identity.id,
            intent: decision.nextSession.intent,
            state: decision.nextSession.state,
            pendingPayload: decision.nextSession.pendingPayload,
            expiresAt: new Date(now.getTime() + env.messagingSessionTtlMinutes * 60 * 1000),
        });
    } else {
        await conversationSessionModel.clearByIdentityId(identity.id);
    }

    return respond(replyText, { stage, pendingAction, listing: createdListing });
}

module.exports = {
    handleInboundMessage,
    NOT_LINKED_TEXT,
    ACCOUNT_INACTIVE_TEXT,
    KITCHEN_ONLY_TEXT,
    CREATE_FAILED_GENERIC_TEXT,
    LINK_INVALID_TEXT,
    LINK_ALREADY_LINKED_TEXT,
    UNSUPPORTED_MESSAGE_TYPE_TEXT,
};
