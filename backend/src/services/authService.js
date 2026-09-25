const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../models/db');
const userModel = require('../models/userModel');
const organizationModel = require('../models/organizationModel');
const AppError = require('../utils/AppError');
const { ROLES, ORG_TYPES, VERIFICATION_STATUS, KITCHEN_ROLES, NGO_ROLES } = require('../utils/constants');

function issueToken(user) {
    return jwt.sign({ sub: user.id, role: user.role, organizationId: user.organization_id }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
    });
}

async function registerOrganization({
    organizationName,
    organizationType,
    pincode,
    latitude,
    longitude,
    serviceRadiusKm,
    name,
    email,
    password,
}) {
    const existing = await userModel.findByEmail(email);
    if (existing) {
        throw new AppError(409, 'An account with this email already exists');
    }

    const isKitchen = organizationType === ORG_TYPES.KITCHEN;
    const adminRole = isKitchen ? ROLES.KITCHEN_MANAGER : ROLES.NGO_ADMIN;
    // Kitchens don't need verification (FR-05 only applies to NGOs); NGOs start
    // pending until a System Admin approves them.
    const verificationStatus = isKitchen ? VERIFICATION_STATUS.VERIFIED : VERIFICATION_STATUS.PENDING;
    const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);

    const { organization, user } = await db.transaction(async (client) => {
        const organization = await organizationModel.create(
            {
                name: organizationName,
                type: organizationType,
                pincode,
                latitude: latitude ?? null,
                longitude: longitude ?? null,
                serviceRadiusKm: serviceRadiusKm ?? null,
                verificationStatus,
            },
            client
        );

        const user = await userModel.create(
            { name, email, passwordHash, role: adminRole, organizationId: organization.id },
            client
        );

        return { organization, user };
    });

    return { token: issueToken(user), user, organization };
}

async function login({ email, password }) {
    const userWithCredentials = await userModel.findByEmailWithCredentials(email);
    if (!userWithCredentials || !userWithCredentials.is_active) {
        throw new AppError(401, 'Invalid email or password');
    }

    const isMatch = await bcrypt.compare(password, userWithCredentials.password_hash);
    if (!isMatch) {
        throw new AppError(401, 'Invalid email or password');
    }

    const user = await userModel.findById(userWithCredentials.id);
    let organization = null;
    if (user.organization_id) {
        organization = await organizationModel.findById(user.organization_id);
    }

    return { token: issueToken(user), user, organization };
}

// Creates a sub-user within an organization. The acting user (admin) determines
// which organization the new user belongs to and which roles they may assign —
// the organization id is NEVER taken verbatim from the request body except for
// SYSTEM_ADMIN, whose supplied id is validated against the organizations table.
async function createUser(actingUser, { name, email, password, role, organizationId }) {
    const existing = await userModel.findByEmail(email);
    if (existing) {
        throw new AppError(409, 'An account with this email already exists');
    }

    let targetOrganizationId;

    if (actingUser.role === ROLES.SYSTEM_ADMIN) {
        if (role === ROLES.SYSTEM_ADMIN) {
            targetOrganizationId = null;
        } else {
            if (!organizationId) {
                throw new AppError(400, 'organizationId is required for this role');
            }
            const organization = await organizationModel.findById(organizationId);
            if (!organization) {
                throw new AppError(404, 'Organization not found');
            }
            assertRoleMatchesOrgType(role, organization.type);
            targetOrganizationId = organization.id;
        }
    } else {
        // Kitchen/NGO admins may only create users inside their own organization.
        targetOrganizationId = actingUser.organizationId;
        const allowedRoles = KITCHEN_ROLES.includes(actingUser.role) ? KITCHEN_ROLES : NGO_ROLES;
        if (!allowedRoles.includes(role)) {
            throw new AppError(403, 'You cannot assign this role');
        }
    }

    const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);
    const user = await userModel.create({ name, email, passwordHash, role, organizationId: targetOrganizationId });
    return user;
}

function assertRoleMatchesOrgType(role, orgType) {
    if (orgType === ORG_TYPES.KITCHEN && !KITCHEN_ROLES.includes(role)) {
        throw new AppError(400, 'This role is not valid for a kitchen organization');
    }
    if (orgType === ORG_TYPES.NGO && !NGO_ROLES.includes(role)) {
        throw new AppError(400, 'This role is not valid for an NGO organization');
    }
}

module.exports = { registerOrganization, login, createUser };
