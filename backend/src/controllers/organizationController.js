const asyncHandler = require('../utils/asyncHandler');
const organizationService = require('../services/organizationService');

const getMe = asyncHandler(async (req, res) => {
    const organization = await organizationService.getOwnOrganization(req.user);
    res.status(200).json({ organization });
});

const updateMe = asyncHandler(async (req, res) => {
    const organization = await organizationService.updateOwnOrganization(req.user, req.body);
    res.status(200).json({ organization });
});

const getById = asyncHandler(async (req, res) => {
    const organization = await organizationService.getOrganizationById(req.user, req.params.id);
    res.status(200).json({ organization });
});

const list = asyncHandler(async (req, res) => {
    const { type, verificationStatus, limit, offset } = req.query;
    const organizations = await organizationService.listOrganizations(req.user, {
        type,
        verificationStatus,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
    });
    res.status(200).json({ organizations });
});

const listPendingNgos = asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const organizations = await organizationService.listPendingNgos({
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
    });
    res.status(200).json({ organizations });
});

const verify = asyncHandler(async (req, res) => {
    const organization = await organizationService.setVerificationStatus(req.params.id, req.body.verificationStatus);
    res.status(200).json({ organization });
});

module.exports = { getMe, updateMe, getById, list, listPendingNgos, verify };
