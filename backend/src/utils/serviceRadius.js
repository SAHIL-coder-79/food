const { haversineDistanceKm } = require('./distance');

// Returns true when ngoOrg is within its own configured service radius of kitchenOrg.
// Fails open (returns true) when radius or coordinates are missing, so surplus listings
// are never hidden due to incomplete location data. Shared by plain radius matching
// (surplusListingService) and smart NGO matching (ai/ngoMatching), which uses it both
// to filter candidates and as its fallback ordering when scoring is unavailable.
function isWithinServiceRadius(kitchenOrg, ngoOrg) {
    if (!ngoOrg.service_radius_km) return true;
    const distance = haversineDistanceKm(
        kitchenOrg.latitude,
        kitchenOrg.longitude,
        ngoOrg.latitude,
        ngoOrg.longitude
    );
    if (distance === null) return true;
    return distance <= ngoOrg.service_radius_km;
}

module.exports = { isWithinServiceRadius };
