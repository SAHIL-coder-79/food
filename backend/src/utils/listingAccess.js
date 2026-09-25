const AppError = require('./AppError');

// Same visibility rule as surplusListingService's own assertVisibleToActingUser: only the owning kitchen or
// the NGO that claimed a listing may see data derived from it (here: its ledger and impact certificate).
// Duplicated in this one small place rather than imported from surplusListingService, to avoid a
// service-to-service dependency cycle (surplusListingService itself calls into the ledger service).
function assertListingVisible(actingUser, listing) {
    const orgId = actingUser.organizationId;
    const isOwningKitchen = orgId != null && listing.kitchen_org_id === orgId;
    const isClaimingNgo = orgId != null && listing.claimed_by_ngo_id === orgId;
    if (!isOwningKitchen && !isClaimingNgo) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
}

module.exports = { assertListingVisible };
