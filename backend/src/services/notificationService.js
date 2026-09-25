const notificationModel = require('../models/notificationModel');
const userModel = require('../models/userModel');
const { KITCHEN_ROLES, NGO_ROLES, NOTIFICATION_TYPES } = require('../utils/constants');

async function notifyOrganization(organizationId, roles, type, message) {
    const users = await userModel.listByOrganizationAndRoles(organizationId, roles);
    if (users.length === 0) return [];
    return notificationModel.createMany(
        users.map((user) => ({ userId: user.id, type, message }))
    );
}

async function notifySurplusPosted(listing, ngoOrgIds) {
    if (!ngoOrgIds || ngoOrgIds.length === 0) return;
    const message = `New surplus listing available: ${listing.quantity} unit(s) of ${listing.food_type || 'food'}.`;
    await Promise.all(
        ngoOrgIds.map((ngoOrgId) =>
            notifyOrganization(ngoOrgId, NGO_ROLES, NOTIFICATION_TYPES.SURPLUS_POSTED, message)
        )
    );
}

async function notifyListingClaimed(listing) {
    const message = `Surplus listing #${listing.id} has been claimed by an NGO.`;
    return notifyOrganization(listing.kitchen_org_id, KITCHEN_ROLES, NOTIFICATION_TYPES.LISTING_CLAIMED, message);
}

async function notifyPickupConfirmed(listing) {
    const message = `Pickup time confirmed for surplus listing #${listing.id}.`;
    return notifyOrganization(listing.claimed_by_ngo_id, NGO_ROLES, NOTIFICATION_TYPES.PICKUP_CONFIRMED, message);
}

async function notifyListingCollected(listing) {
    const message = `Surplus listing #${listing.id} has been marked as collected.`;
    await Promise.all([
        notifyOrganization(listing.kitchen_org_id, KITCHEN_ROLES, NOTIFICATION_TYPES.LISTING_COLLECTED, message),
        notifyOrganization(listing.claimed_by_ngo_id, NGO_ROLES, NOTIFICATION_TYPES.LISTING_COLLECTED, message),
    ]);
}

async function notifyNgoVerificationResult(organizationId, verificationStatus) {
    const message = `Your NGO registration has been ${verificationStatus}.`;
    return notifyOrganization(
        organizationId,
        NGO_ROLES,
        NOTIFICATION_TYPES.NGO_VERIFICATION_RESULT,
        message
    );
}

module.exports = {
    notifySurplusPosted,
    notifyListingClaimed,
    notifyPickupConfirmed,
    notifyListingCollected,
    notifyNgoVerificationResult,
    listForUser: notificationModel.listForUser,
    markRead: notificationModel.markRead,
    markAllRead: notificationModel.markAllRead,
};
