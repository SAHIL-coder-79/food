const asyncHandler = require('../utils/asyncHandler');
const surplusListingService = require('../services/surplusListingService');

const create = asyncHandler(async (req, res) => {
    const { listing, spoilageAssessment } = await surplusListingService.createListing(req.user, req.body);
    res.status(201).json({ listing, spoilageAssessment });
});

const spoilageEstimate = asyncHandler(async (req, res) => {
    const spoilageAssessment = surplusListingService.estimateSpoilage(req.body);
    res.status(200).json({ spoilageAssessment });
});

const spoilageAssessment = asyncHandler(async (req, res) => {
    const { ambientTemperatureC } = req.query;
    const assessment = await surplusListingService.getListingSpoilageAssessment(req.user, req.params.id, { ambientTemperatureC });
    res.status(200).json({ spoilageAssessment: assessment });
});

const listOwn = asyncHandler(async (req, res) => {
    const { status, limit, offset } = req.query;
    const listings = await surplusListingService.listOwnListings(req.user, {
        status,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
    });
    res.status(200).json({ listings });
});

const feed = asyncHandler(async (req, res) => {
    const listings = await surplusListingService.getFeedForNgo(req.user);
    res.status(200).json({ listings });
});

const getById = asyncHandler(async (req, res) => {
    const listing = await surplusListingService.getListingById(req.user, req.params.id);
    res.status(200).json({ listing });
});

const claim = asyncHandler(async (req, res) => {
    const listing = await surplusListingService.claimListing(req.user, req.params.id, req.body);
    res.status(200).json({ listing });
});

const confirmPickup = asyncHandler(async (req, res) => {
    const listing = await surplusListingService.confirmPickup(req.user, req.params.id, req.body);
    res.status(200).json({ listing });
});

const collect = asyncHandler(async (req, res) => {
    const listing = await surplusListingService.collectListing(req.user, req.params.id, req.body);
    res.status(200).json({ listing });
});

const ngoMatches = asyncHandler(async (req, res) => {
    const matches = await surplusListingService.getNgoMatchesForListing(req.user, req.params.id);
    res.status(200).json({ matches });
});

module.exports = { create, spoilageEstimate, spoilageAssessment, listOwn, feed, getById, claim, confirmPickup, collect, ngoMatches };
