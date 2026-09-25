const ROLES = Object.freeze({
    KITCHEN_STAFF: 'KITCHEN_STAFF',
    KITCHEN_MANAGER: 'KITCHEN_MANAGER',
    NGO_COORDINATOR: 'NGO_COORDINATOR',
    NGO_ADMIN: 'NGO_ADMIN',
    SYSTEM_ADMIN: 'SYSTEM_ADMIN',
});

const KITCHEN_ROLES = [ROLES.KITCHEN_STAFF, ROLES.KITCHEN_MANAGER];
const NGO_ROLES = [ROLES.NGO_COORDINATOR, ROLES.NGO_ADMIN];

const ORG_TYPES = Object.freeze({
    KITCHEN: 'kitchen',
    NGO: 'ngo',
});

const VERIFICATION_STATUS = Object.freeze({
    PENDING: 'pending',
    VERIFIED: 'verified',
    REJECTED: 'rejected',
});

const LISTING_STATUS = Object.freeze({
    AVAILABLE: 'Available',
    CLAIMED: 'Claimed',
    COLLECTED: 'Collected',
    EXPIRED: 'Expired',
});

const MEAL_SLOTS = ['BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER'];

const NOTIFICATION_TYPES = Object.freeze({
    SURPLUS_POSTED: 'SURPLUS_POSTED',
    LISTING_CLAIMED: 'LISTING_CLAIMED',
    PICKUP_CONFIRMED: 'PICKUP_CONFIRMED',
    LISTING_COLLECTED: 'LISTING_COLLECTED',
    LISTING_EXPIRED: 'LISTING_EXPIRED',
    NGO_VERIFICATION_RESULT: 'NGO_VERIFICATION_RESULT',
});

// Donation Integrity Ledger (Task 17) event types - one hash-chained ledger entry is appended for each of
// these as it genuinely happens in the existing surplus lifecycle (see services/donationLedgerService.js).
// Every event occurs at most once per listing: there is no "unclaim" or repeat-collect flow.
const LEDGER_EVENT_TYPES = Object.freeze({
    SURPLUS_CREATED: 'SURPLUS_CREATED',
    SURPLUS_CLAIMED: 'SURPLUS_CLAIMED',
    PICKUP_CONFIRMED: 'PICKUP_CONFIRMED',
    SURPLUS_COLLECTED: 'SURPLUS_COLLECTED',
    SURPLUS_EXPIRED: 'SURPLUS_EXPIRED',
});

module.exports = {
    ROLES,
    KITCHEN_ROLES,
    NGO_ROLES,
    ORG_TYPES,
    VERIFICATION_STATUS,
    LISTING_STATUS,
    MEAL_SLOTS,
    NOTIFICATION_TYPES,
    LEDGER_EVENT_TYPES,
};
