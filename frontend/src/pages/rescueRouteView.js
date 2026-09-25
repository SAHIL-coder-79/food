// Pure helpers for the "Rescue Route" batching UI: shaping POST /api/rescue-routes/preview's response for
// display. This is a deterministic PLANNING estimate, never live navigation - see TIME_STATUS_LABEL wording
// and buildRouteView's originLabel, which are deliberately worded as estimates, not guarantees.

export const TIME_STATUS_LABEL = {
  SAFE: 'On track',
  AT_RISK: 'At risk of running late',
  EXPIRED_BY_ESTIMATE: 'Likely too late by this estimate',
};

export const TIME_STATUS_BADGE = {
  SAFE: 'badge-success',
  AT_RISK: 'badge-warning',
  EXPIRED_BY_ESTIMATE: 'badge-danger',
};

export function timeStatusLabel(status) {
  return TIME_STATUS_LABEL[status] || status;
}

export function timeStatusBadge(status) {
  return TIME_STATUS_BADGE[status] || 'badge-neutral';
}

function originLabel(origin) {
  if (!origin) return 'No stops to route';
  return origin.type === 'NGO'
    ? "Your organization's saved location"
    : 'The first pickup stop (no saved organization location, so the route starts there)';
}

// Shapes { routeId, origin, stops, totalDistanceKm, estimatedTravelMinutes, travelTimeType, routeQuality,
// warnings } into a display-ready object. Per-stop AT_RISK/EXPIRED_BY_ESTIMATE warnings are attached to their
// stop; warnings about a listing that never became a stop at all (e.g. missing coordinates) are kept separate
// as route-level warnings, since there is no stop row to attach them to.
export function buildRouteView(route) {
  if (!route) return null;

  const stops = Array.isArray(route.stops) ? route.stops : [];
  const stopListingIds = new Set(stops.map((s) => s.listingId));
  const warningsByListingId = {};
  const routeLevelWarnings = [];

  (route.warnings || []).forEach((w) => {
    if (w.listingId != null && stopListingIds.has(w.listingId)) {
      warningsByListingId[w.listingId] = w.message;
    } else {
      routeLevelWarnings.push(w.message);
    }
  });

  return {
    routeId: route.routeId,
    origin: route.origin,
    originLabel: originLabel(route.origin),
    stops: stops.map((s) => ({
      ...s,
      statusLabel: timeStatusLabel(s.timeStatus),
      badgeClass: timeStatusBadge(s.timeStatus),
      warningMessage: warningsByListingId[s.listingId] || null,
    })),
    totalDistanceKm: route.totalDistanceKm,
    estimatedTravelMinutes: route.estimatedTravelMinutes,
    routeLevelWarnings,
    isEmpty: stops.length === 0,
  };
}
