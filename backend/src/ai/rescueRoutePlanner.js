'use strict';

// Deterministic Rescue Route Planning - a pure, explainable heuristic for sequencing an NGO's pickups across
// several already-claimed surplus listings. It is NOT a navigation engine: there is no live traffic, no real
// road network, no GPS, and no claim of an optimal (shortest-possible) route. Every distance is a straight-line
// (Haversine) estimate and every travel time is that distance divided by one configurable average speed. See
// the README-style comments below for exactly how each number is derived; the same design also underlies the
// PLAN dashboard stage this feature extends (see ai/rescuePriority.js's own SAFE/urgency framing).
//
// This module does no I/O: it only shapes and sequences the data it is given. Fetching listings, checking
// ownership, and enforcing the eligibility rules all live in services/rescueRouteService.js.

const { haversineDistanceKm } = require('../utils/distance');

const TRAVEL_TIME_TYPE = 'ESTIMATED_STRAIGHT_LINE';
const ROUTE_QUALITY = 'ESTIMATED';

function minutesBetween(laterDate, earlierDate) {
    return (laterDate.getTime() - earlierDate.getTime()) / (1000 * 60);
}

// Picks the single best next stop out of `remaining`, given the vehicle's current position (may be unknown -
// null - only on the very first pick when there is no NGO origin coordinate).
//
// Selection rule (in this exact priority order - see Task 18 section 4, Step 3):
//   1. Urgency first: if one candidate's safe-until time is more than `urgencyTieBreakMinutes` earlier than
//      another's, the more urgent one is chosen, regardless of distance. This is deliberately a hard cutoff,
//      not a weighted blend, so the rule stays explainable: "clearly more urgent wins outright."
//   2. Otherwise (urgency is roughly comparable): the geographically nearest unvisited stop wins. A stop
//      whose distance from the current position cannot be computed (should not normally happen - callers are
//      expected to have already excluded coordinate-less listings) sorts after every stop with a known distance.
//   3. Final tiebreak: ascending listing id, so the result is 100% deterministic even for identical distances.
function selectNextStop(remaining, currentLat, currentLon, now, urgencyTieBreakMinutes) {
    const withDistance = remaining.map((stop) => ({
        stop,
        distanceFromCurrent:
            currentLat != null && currentLon != null
                ? haversineDistanceKm(currentLat, currentLon, stop.latitude, stop.longitude)
                : null,
        remainingMinutes: minutesBetween(new Date(stop.safeUntilTime), now),
    }));

    withDistance.sort((a, b) => {
        const urgencyDeltaMinutes = a.remainingMinutes - b.remainingMinutes;
        if (Math.abs(urgencyDeltaMinutes) > urgencyTieBreakMinutes) {
            return urgencyDeltaMinutes; // more urgent (smaller remaining time) sorts first
        }
        if (a.distanceFromCurrent !== b.distanceFromCurrent) {
            if (a.distanceFromCurrent === null) return 1;
            if (b.distanceFromCurrent === null) return -1;
            return a.distanceFromCurrent - b.distanceFromCurrent;
        }
        return a.stop.listingId - b.stop.listingId;
    });

    return withDistance[0];
}

function classifyTimeStatus(estimatedArrival, safeUntil, atRiskBufferMinutes) {
    if (estimatedArrival.getTime() > safeUntil.getTime()) {
        return 'EXPIRED_BY_ESTIMATE';
    }
    const bufferMs = atRiskBufferMinutes * 60 * 1000;
    if (safeUntil.getTime() - estimatedArrival.getTime() <= bufferMs) {
        return 'AT_RISK';
    }
    return 'SAFE';
}

/**
 * Plans a deterministic pickup sequence.
 *
 * @param {Object} params
 * @param {{type: 'NGO', latitude: number, longitude: number} | {type: 'FIRST_STOP'}} params.origin
 *   'NGO' when the requesting NGO organization has stored coordinates (its own location is the route's real
 *   start). 'FIRST_STOP' when it does not - coordinates are never invented, so the route instead starts from
 *   wherever the first selected stop happens to be, and the response says so plainly.
 * @param {Array<{listingId:number, latitude:number, longitude:number, safeUntilTime:string|Date, quantity:number, priorityScore?:number}>} params.stops
 *   Already-eligible, coordinate-bearing stops (filtering/ownership happens in the service layer).
 * @param {Date} params.routeStartTime When the NGO sets off - defaults to "now" by the caller.
 * @param {{averageSpeedKmh:number, pickupServiceMinutes:number, atRiskBufferMinutes:number, urgencyTieBreakMinutes:number}} params.config
 */
function planRoute({ origin, stops, routeStartTime, config }) {
    const { averageSpeedKmh, pickupServiceMinutes, atRiskBufferMinutes, urgencyTieBreakMinutes } = config;

    if (stops.length === 0) {
        return {
            origin: origin.type === 'NGO' ? origin : null,
            stops: [],
            totalDistanceKm: 0,
            estimatedTravelMinutes: 0,
            travelTimeType: TRAVEL_TIME_TYPE,
            routeQuality: ROUTE_QUALITY,
            warnings: [],
        };
    }

    const remaining = [...stops];
    const sequencedStops = [];
    const warnings = [];

    let currentLat = origin.type === 'NGO' ? origin.latitude : null;
    let currentLon = origin.type === 'NGO' ? origin.longitude : null;
    let resolvedOrigin = origin.type === 'NGO' ? { type: 'NGO', latitude: origin.latitude, longitude: origin.longitude } : null;

    let cumulativeDistanceKm = 0;
    let cumulativeTravelMinutes = 0;
    let elapsedServiceMinutes = 0;
    const now = new Date(routeStartTime);

    let sequence = 1;
    while (remaining.length > 0) {
        const picked = selectNextStop(remaining, currentLat, currentLon, now, urgencyTieBreakMinutes);
        const stop = picked.stop;
        remaining.splice(remaining.indexOf(stop), 1);

        // The very first stop, when there is no NGO origin, defines the route's displayed starting point.
        const isFirstStopAsOrigin = resolvedOrigin === null;
        const distanceFromPreviousKm = isFirstStopAsOrigin
            ? 0
            : haversineDistanceKm(currentLat, currentLon, stop.latitude, stop.longitude);

        if (isFirstStopAsOrigin) {
            resolvedOrigin = { type: 'FIRST_STOP', latitude: stop.latitude, longitude: stop.longitude };
        }

        cumulativeDistanceKm += distanceFromPreviousKm || 0;
        const legTravelMinutes = ((distanceFromPreviousKm || 0) / averageSpeedKmh) * 60;
        cumulativeTravelMinutes += legTravelMinutes;

        const estimatedArrivalTime = new Date(now.getTime() + (cumulativeTravelMinutes + elapsedServiceMinutes) * 60 * 1000);
        const safeUntil = new Date(stop.safeUntilTime);
        const timeStatus = classifyTimeStatus(estimatedArrivalTime, safeUntil, atRiskBufferMinutes);

        if (timeStatus === 'AT_RISK') {
            warnings.push({
                listingId: stop.listingId,
                message: `Stop #${sequence} (listing ${stop.listingId}) is estimated to arrive close to its safe-until time - pickup is at risk of running late.`,
            });
        } else if (timeStatus === 'EXPIRED_BY_ESTIMATE') {
            warnings.push({
                listingId: stop.listingId,
                message: `Stop #${sequence} (listing ${stop.listingId}) is estimated to arrive AFTER its safe-until time at this position in the route. Consider resequencing or picking it up first.`,
            });
        }

        sequencedStops.push({
            sequence,
            listingId: stop.listingId,
            latitude: stop.latitude,
            longitude: stop.longitude,
            quantity: stop.quantity,
            priorityScore: stop.priorityScore ?? null,
            distanceFromPreviousKm: distanceFromPreviousKm === null ? null : Math.round(distanceFromPreviousKm * 100) / 100,
            cumulativeDistanceKm: Math.round(cumulativeDistanceKm * 100) / 100,
            estimatedArrivalTime: estimatedArrivalTime.toISOString(),
            safeUntilTime: safeUntil.toISOString(),
            timeStatus,
        });

        currentLat = stop.latitude;
        currentLon = stop.longitude;
        elapsedServiceMinutes += pickupServiceMinutes;
        sequence += 1;
    }

    return {
        origin: resolvedOrigin,
        stops: sequencedStops,
        totalDistanceKm: Math.round(cumulativeDistanceKm * 100) / 100,
        estimatedTravelMinutes: Math.round(cumulativeTravelMinutes),
        travelTimeType: TRAVEL_TIME_TYPE,
        routeQuality: ROUTE_QUALITY,
        warnings,
    };
}

module.exports = { planRoute, selectNextStop, classifyTimeStatus, TRAVEL_TIME_TYPE, ROUTE_QUALITY };
