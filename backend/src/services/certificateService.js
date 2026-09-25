const pool = require('../models/db');
const surplusListingModel = require('../models/surplusListingModel');
const organizationModel = require('../models/organizationModel');
const transactionModel = require('../models/transactionModel');
const donationLedgerService = require('./donationLedgerService');
const AppError = require('../utils/AppError');
const { assertListingVisible } = require('../utils/listingAccess');
const { LISTING_STATUS } = require('../utils/constants');

// Same estimate factors already used by ai/financialIntelligence.js (live financial-impact report) and
// ai/rescuePriority.js (meal-equivalent impact score) - reused here, not a new formula, so a certificate's
// figures agree with what those pages already show for the same donation.
const CO2E_KG_PER_UNIT = 2.5;
const MEAL_EQUIVALENT_KG = 0.4;

// Real per-donation cost, if this listing was linked to a daily log recording it (dailyLogId is optional on
// a listing). Never invented: if there is no linked daily log, financial impact is reported as unavailable
// rather than guessed.
async function loadFinancialImpact(listing, quantityCollected) {
    if (!listing.daily_log_id) {
        return { available: false };
    }
    const { rows } = await pool.query(
        `SELECT COALESCE(mi.cost_per_unit, 0) AS cost_per_unit, COALESCE(mi.preparation_cost_per_unit, 0) AS preparation_cost_per_unit
         FROM daily_logs dl JOIN menu_items mi ON mi.id = dl.menu_item_id
         WHERE dl.id = $1`,
        [listing.daily_log_id]
    );
    if (rows.length === 0) {
        return { available: false };
    }
    const { cost_per_unit: costPerUnit, preparation_cost_per_unit: prepCostPerUnit } = rows[0];
    const valueInr = Math.round(quantityCollected * (Number(costPerUnit) + Number(prepCostPerUnit)) * 100) / 100;
    return { available: true, valueInr, isEstimate: true };
}

// Builds a lightweight impact certificate for one donation, from real stored data only. This is explicitly
// a FoodShare AI prototype artifact, not a legally binding certification of any kind (see disclaimer field).
async function getCertificate(actingUser, listingId) {
    const listing = await surplusListingModel.findById(listingId);
    if (!listing) {
        throw new AppError(404, 'Surplus listing not found');
    }
    assertListingVisible(actingUser, listing);

    if (listing.status !== LISTING_STATUS.COLLECTED) {
        throw new AppError(409, 'A certificate can only be issued once this donation has been collected.');
    }

    const transaction = await transactionModel.findByListingId(listing.id);
    if (!transaction) {
        // Should not happen alongside a Collected status (both are written in the same transaction), but
        // never fabricate a certificate from a status flag alone if the underlying record is missing.
        throw new AppError(409, 'A certificate can only be issued once this donation has been collected.');
    }

    const [kitchenOrg, ngoOrg, ledgerVerification] = await Promise.all([
        organizationModel.findById(listing.kitchen_org_id),
        listing.claimed_by_ngo_id ? organizationModel.findById(listing.claimed_by_ngo_id) : null,
        donationLedgerService.verifyLedger(actingUser, listing.id),
    ]);

    const quantityCollected = Number(transaction.quantity_collected);
    const financialImpact = await loadFinancialImpact(listing, quantityCollected);
    const environmentalImpact = {
        co2eAvoidedKg: Math.round(quantityCollected * CO2E_KG_PER_UNIT * 10) / 10,
        mealEquivalents: Math.floor(quantityCollected / MEAL_EQUIVALENT_KG),
        isEstimate: true,
    };

    // Deterministic, not stored: derived from the ledger's own final hash, so the certificate id is itself
    // tied to (and would change if anyone tampered with) the donation's audit trail.
    const certificateId = `FSA-CERT-${listing.id}-${(ledgerVerification.lastHash || '0'.repeat(16)).slice(0, 16).toUpperCase()}`;

    return {
        certificateId,
        listingId: listing.id,
        foodType: listing.food_type,
        donorOrganization: kitchenOrg ? { id: kitchenOrg.id, name: kitchenOrg.name } : null,
        receivingOrganization: ngoOrg ? { id: ngoOrg.id, name: ngoOrg.name } : null,
        quantityCollected,
        collectedAt: new Date(transaction.collected_at).toISOString(),
        financialImpact,
        environmentalImpact,
        ledgerVerification,
        generatedAt: new Date().toISOString(),
        disclaimer:
            'FoodShare AI Prototype certificate - generated for demonstration purposes from this system\'s own records. ' +
            'It is not a legal, tax, food-safety or regulatory certification. Financial and environmental figures are estimates.',
    };
}

module.exports = { getCertificate };
