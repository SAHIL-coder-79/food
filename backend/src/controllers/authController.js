const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/authService');
const organizationModel = require('../models/organizationModel');

const registerOrganization = asyncHandler(async (req, res) => {
    const result = await authService.registerOrganization(req.body);
    res.status(201).json(result);
});

const login = asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    res.status(200).json(result);
});

const createUser = asyncHandler(async (req, res) => {
    const user = await authService.createUser(req.user, req.body);
    res.status(201).json({ user });
});

const me = asyncHandler(async (req, res) => {
    let organization = null;
    if (req.user.organizationId) {
        organization = await organizationModel.findById(req.user.organizationId);
    }
    res.status(200).json({ user: req.user, organization });
});

module.exports = { registerOrganization, login, createUser, me };
