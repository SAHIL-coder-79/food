'use strict';

const crypto = require('crypto');
const messagingIdentityModel = require('../models/messagingIdentityModel');
const messagingLinkRequestModel = require('../models/messagingLinkRequestModel');
const userModel = require('../models/userModel');
const AppError = require('../utils/AppError');
const env = require('../config/env');

// Unambiguous charset (no 0/O, 1/I/L) so a code read aloud or typed on a phone keyboard is never misread.
const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_CHARSET[crypto.randomInt(CODE_CHARSET.length)];
    }
    return `FS-${code}`;
}

// Direct self-claim (Task 20) is safe ONLY for the mock provider: a test id has no real owner to impersonate.
// For any real provider (Meta WhatsApp), a phone number is someone's real, single identity - directly
// claiming an arbitrary externalUserId would let anyone type in someone else's number and hijack it. Real
// providers must go through createLinkRequest/completeLinkFromCode instead, which proves control of the
// number via the messaging channel itself before any link is created.
async function linkIdentity(actingUser, { provider, channel, externalUserId }) {
    if (provider !== 'mock') {
        throw new AppError(
            400,
            'Direct linking is only available for the mock provider. Use POST /api/messaging/link-requests to link a real WhatsApp number.'
        );
    }
    const existing = await messagingIdentityModel.findByExternalContact(provider, channel, externalUserId);
    if (existing) {
        throw new AppError(409, 'This contact is already linked to a FoodShare account.');
    }
    return messagingIdentityModel.create({
        provider,
        channel,
        externalUserId,
        userId: actingUser.id,
        organizationId: actingUser.organizationId,
    });
}

async function listOwnIdentities(actingUser) {
    return messagingIdentityModel.listByUserId(actingUser.id);
}

// Step 1 of the secure linking flow: an authenticated user requests a short-lived, single-use code. Nothing
// is linked yet - organizationId/userId are captured now (from the authenticated session, never from a later
// message) so the eventual link is bound to who requested it, not to whoever happens to send the code.
async function createLinkRequest(actingUser, { provider, channel }) {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + env.messagingLinkRequestTtlMinutes * 60 * 1000);
    await messagingLinkRequestModel.create({
        code,
        userId: actingUser.id,
        organizationId: actingUser.organizationId,
        provider,
        channel,
        expiresAt,
    });
    return {
        code,
        expiresAt: expiresAt.toISOString(),
        instructions: `From the WhatsApp number you want to link, send this exact message: ${code}`,
    };
}

// Step 2: called from the messaging webhook when an UNKNOWN sender's message looks like a linking code.
// Redemption is atomic at the database level (messagingLinkRequestModel.consumeIfValid) - a code can never be
// redeemed twice, even by two messages arriving at nearly the same instant, and an expired code is refused by
// the database's own WHERE clause, not just an application-level timestamp comparison that could race.
async function completeLinkFromCode({ code, provider, channel, externalUserId }) {
    const request = await messagingLinkRequestModel.consumeIfValid(code);
    if (!request) {
        return { ok: false, reason: 'invalid_or_expired' };
    }
    if (request.provider !== provider || request.channel !== channel) {
        // The code is already spent at this point (by design - see the migration's comment on why burning an
        // unusable code is the safe failure mode), so this can't be retried with the right provider/channel.
        return { ok: false, reason: 'invalid_or_expired' };
    }

    const existing = await messagingIdentityModel.findByExternalContact(provider, channel, externalUserId);
    if (existing) {
        // This WhatsApp number is already linked to some FoodShare account (possibly someone else's) - never
        // reassign it. Prevents exactly the "identity takeover" scenario Task 21 calls out.
        return { ok: false, reason: 'already_linked' };
    }

    const identity = await messagingIdentityModel.create({
        provider,
        channel,
        externalUserId,
        userId: request.userId,
        organizationId: request.organizationId,
    });
    return { ok: true, identity };
}

// LOCAL DEVELOPMENT/DEMO ONLY - never called from the real /webhook path, only from the /test/inbound
// controller (routes/messagingRoutes.js already refuses that whole route with a 404 in production). Lets the
// documented demo scenario ("message from demo-kitchen-whatsapp") work with zero manual linking, by resolving
// a first-contact-from-an-unknown-sender to a FoodShare user the DEVELOPER configured via
// TEST_MESSAGING_KITCHEN_USER_ID - never a value taken from the request. A misconfigured/inactive/missing
// user id fails open to the ordinary "not linked" response rather than throwing, since this is a convenience,
// not a required step.
async function ensureDemoIdentityIfConfigured(provider, channel, externalUserId) {
    if (env.nodeEnv === 'production') return null;
    if (!env.testMessagingKitchenUserId) return null;

    const existing = await messagingIdentityModel.findByExternalContact(provider, channel, externalUserId);
    if (existing) return existing; // already resolved normally - nothing to auto-provision

    const user = await userModel.findById(env.testMessagingKitchenUserId);
    if (!user || !user.is_active || !user.organization_id) return null;

    return messagingIdentityModel.create({ provider, channel, externalUserId, userId: user.id, organizationId: user.organization_id });
}

module.exports = { linkIdentity, listOwnIdentities, createLinkRequest, completeLinkFromCode, ensureDemoIdentityIfConfigured };
