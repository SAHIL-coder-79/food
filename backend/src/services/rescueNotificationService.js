'use strict';

const surplusListingModel = require('../models/surplusListingModel');
const organizationModel = require('../models/organizationModel');
const userModel = require('../models/userModel');
const notificationModel = require('../models/notificationModel');
const ngoMatching = require('../ai/ngoMatching');
const communicationService = require('../integrations/communication/service');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const { LISTING_STATUS, NGO_ROLES, NOTIFICATION_TYPES } = require('../utils/constants');

// Communication is only ever a delivery channel for a rescue opportunity FoodShare's own matching already
// found - never a second source of truth. Only NGOs the existing ranked-match algorithm (ai/ngoMatching.js)
// already considers a good fit are notified; nothing here re-derives or second-guesses that ranking.
const MATCH_LEVELS_TO_NOTIFY = ['EXCELLENT', 'GOOD'];

// In-memory, per-listing cooldown: a soft anti-spam guard against a kitchen (or a retried request) re-sending
// the same rescue notification every few seconds. Deliberately NOT persisted - a server restart clearing it is
// an acceptable trade-off for a guard that only needs to survive one session, not a security control.
const lastNotifiedAt = new Map();

function resetCooldowns() {
    lastNotifiedAt.clear();
}

function buildMessageBody(listing, kitchenOrg) {
    const safeUntil = new Date(listing.safe_until_time).toISOString();
    return (
        `Rescue opportunity: ${listing.quantity} unit(s) of ${listing.food_type || 'food'} available from ` +
        `${kitchenOrg.name}${kitchenOrg.pincode ? ` (${kitchenOrg.pincode})` : ''}. Safe until ${safeUntil}. ` +
        `Listing #${listing.id}. Open the FoodShare app to review and claim.`
    );
}

// Sends the SAME body to every active user of one NGO organization. The in-app notification (the existing
// notification system's own source of truth) is created unconditionally; the external channel is a best-effort
// addition on top of it and can never undo or block it.
async function notifyOneOrganization(ngoOrgId, body) {
    const users = await userModel.listByOrganizationAndRoles(ngoOrgId, NGO_ROLES);
    if (users.length === 0) {
        return { accepted: false, messagesSent: 0, deliveries: [], error: 'No active NGO users found for this organization' };
    }

    await notificationModel.createMany(users.map((user) => ({ userId: user.id, type: NOTIFICATION_TYPES.SURPLUS_POSTED, message: body })));

    // Mock/real providers have no phone number to address (none exists in the schema, and Task 19 explicitly
    // says not to invent one) - the existing user email is reused as the recipient identifier instead. A real
    // WhatsApp/SMS provider would need a phone number field added at that point; see the final report.
    const deliveries = users.map((user) => {
        try {
            const result = communicationService.sendMessage({ to: user.email, channel: env.communicationDefaultChannel, body });
            return { userId: user.id, ...result };
        } catch (error) {
            // Belt-and-braces: communicationService.sendMessage already catches provider errors itself, but a
            // rescue notification must never fail the request no matter where a failure occurs.
            return { userId: user.id, accepted: false, error: error.message };
        }
    });

    return {
        accepted: deliveries.some((d) => d.accepted),
        messagesSent: deliveries.filter((d) => d.accepted).length,
        deliveries,
    };
}

/**
 * Notifies the top-ranked matched NGOs about one of the requesting kitchen's own Available listings. Every
 * fact in the message (quantity, food type, kitchen name/pincode, safe-until time, listing id) comes straight
 * from the database; nothing is accepted from the request body beyond the listing id itself.
 */
async function notifyMatchedNgos(actingUser, listingId) {
    const listing = await surplusListingModel.findById(listingId);
    if (!listing) {
        throw new AppError(404, 'Surplus listing not found');
    }
    if (listing.kitchen_org_id !== actingUser.organizationId) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    if (listing.status !== LISTING_STATUS.AVAILABLE) {
        throw new AppError(409, 'Only active (Available) listings can be notified to NGOs');
    }

    const lastSent = lastNotifiedAt.get(listing.id);
    if (lastSent && Date.now() - lastSent < env.rescueNotificationCooldownMs) {
        const retryAfterSeconds = Math.ceil((env.rescueNotificationCooldownMs - (Date.now() - lastSent)) / 1000);
        throw new AppError(429, `This listing was already notified recently. Try again in ${retryAfterSeconds} second(s).`);
    }

    const kitchenOrg = await organizationModel.findById(listing.kitchen_org_id);
    const ranked = await ngoMatching.getRankedMatches(listing, kitchenOrg);
    const recipients = ranked.filter((m) => MATCH_LEVELS_TO_NOTIFY.includes(m.matchLevel)).slice(0, env.rescueNotificationMaxRecipients);

    if (recipients.length === 0) {
        return {
            recipientCount: 0,
            results: [],
            provider: env.communicationProvider,
            communicationEnabled: env.communicationEnabled,
        };
    }

    const body = buildMessageBody(listing, kitchenOrg);
    const results = [];
    for (const match of recipients) {
        // Sequential on purpose: keeps the per-organization notification calls simple to reason about and test;
        // recipient counts are small (bounded by rescueNotificationMaxRecipients) so this is not a bottleneck.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await notifyOneOrganization(match.ngoOrgId, body);
        results.push({ organizationId: match.ngoOrgId, matchLevel: match.matchLevel, ...outcome });
    }

    lastNotifiedAt.set(listing.id, Date.now());

    return {
        recipientCount: recipients.length,
        results,
        provider: env.communicationProvider,
        communicationEnabled: env.communicationEnabled,
    };
}

module.exports = { notifyMatchedNgos, resetCooldowns };
