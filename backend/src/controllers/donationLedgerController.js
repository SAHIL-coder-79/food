const asyncHandler = require('../utils/asyncHandler');
const donationLedgerService = require('../services/donationLedgerService');
const certificateService = require('../services/certificateService');

const getLedger = asyncHandler(async (req, res) => {
    const data = await donationLedgerService.getLedger(req.user, req.params.listingId);
    res.status(200).json({ status: 'success', data });
});

const verifyLedger = asyncHandler(async (req, res) => {
    const data = await donationLedgerService.verifyLedger(req.user, req.params.listingId);
    res.status(200).json({ status: 'success', data });
});

const getCertificate = asyncHandler(async (req, res) => {
    const data = await certificateService.getCertificate(req.user, req.params.listingId);
    res.status(200).json({ status: 'success', data });
});

module.exports = { getLedger, verifyLedger, getCertificate };
