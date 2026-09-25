const organizationModel = require('../models/organizationModel');
const notificationService = require('./notificationService');
const AppError = require('../utils/AppError');
const { ROLES, ORG_TYPES, VERIFICATION_STATUS, KITCHEN_ROLES } = require('../utils/constants');

async function getOwnOrganization(actingUser) {
    if (!actingUser.organizationId) {
        throw new AppError(404, 'This account is not associated with an organization');
    }
    const organization = await organizationModel.findById(actingUser.organizationId);
    if (!organization) {
        throw new AppError(404, 'Organization not found');
    }
    return organization;
}

async function updateOwnOrganization(actingUser, fields) {
    await getOwnOrganization(actingUser); // ensures it exists / is theirs
    return organizationModel.update(actingUser.organizationId, fields);
}

async function getOrganizationById(actingUser, id) {
    if (actingUser.role !== ROLES.SYSTEM_ADMIN && actingUser.organizationId !== Number(id)) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    const organization = await organizationModel.findById(id);
    if (!organization) {
        throw new AppError(404, 'Organization not found');
    }
    return organization;
}

// Directory listing, scoped by the acting user's role (FR-20 / verification queue).
async function listOrganizations(actingUser, { type, verificationStatus, limit, offset }) {
    if (actingUser.role === ROLES.SYSTEM_ADMIN) {
        return organizationModel.list({ type, verificationStatus, limit, offset });
    }

    if (KITCHEN_ROLES.includes(actingUser.role)) {
        // Kitchens may only browse the verified NGO directory.
        return organizationModel.list({
            type: ORG_TYPES.NGO,
            verificationStatus: VERIFICATION_STATUS.VERIFIED,
            limit,
            offset,
        });
    }

    // NGO roles may browse kitchens (all kitchens are auto-verified).
    return organizationModel.list({ type: ORG_TYPES.KITCHEN, limit, offset });
}

async function listPendingNgos({ limit, offset }) {
    return organizationModel.list({
        type: ORG_TYPES.NGO,
        verificationStatus: VERIFICATION_STATUS.PENDING,
        limit,
        offset,
    });
}

async function setVerificationStatus(id, verificationStatus) {
    const organization = await organizationModel.findById(id);
    if (!organization) {
        throw new AppError(404, 'Organization not found');
    }
    if (organization.type !== ORG_TYPES.NGO) {
        throw new AppError(400, 'Only NGO organizations require verification');
    }

    const updated = await organizationModel.updateVerificationStatus(id, verificationStatus);
    await notificationService.notifyNgoVerificationResult(id, verificationStatus);
    return updated;
}

module.exports = {
    getOwnOrganization,
    updateOwnOrganization,
    getOrganizationById,
    listOrganizations,
    listPendingNgos,
    setVerificationStatus,
};
