const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
}

// Haversine straight-line distance between two lat/long points, in kilometers.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    if ([lat1, lon1, lat2, lon2].some((value) => value === null || value === undefined)) {
        return null;
    }

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_KM * c;
}

module.exports = { haversineDistanceKm };
