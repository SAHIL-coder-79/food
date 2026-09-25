import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeStatusLabel, timeStatusBadge, buildRouteView } from './rescueRouteView.js';

test('timeStatusLabel and timeStatusBadge cover every documented status', () => {
  ['SAFE', 'AT_RISK', 'EXPIRED_BY_ESTIMATE'].forEach((status) => {
    assert.equal(typeof timeStatusLabel(status), 'string');
    assert.match(timeStatusBadge(status), /^badge-/);
  });
});

test('timeStatusLabel/Badge fall back gracefully for an unrecognised status', () => {
  assert.equal(timeStatusLabel('SOMETHING_ELSE'), 'SOMETHING_ELSE');
  assert.equal(timeStatusBadge('SOMETHING_ELSE'), 'badge-neutral');
});

test('buildRouteView returns null with no route yet', () => {
  assert.equal(buildRouteView(null), null);
});

test('buildRouteView labels an NGO origin distinctly from a FIRST_STOP origin', () => {
  const ngoOrigin = buildRouteView({ routeId: 'r1', origin: { type: 'NGO', latitude: 1, longitude: 2 }, stops: [], totalDistanceKm: 0, estimatedTravelMinutes: 0, warnings: [] });
  const firstStopOrigin = buildRouteView({ routeId: 'r2', origin: { type: 'FIRST_STOP', latitude: 1, longitude: 2 }, stops: [], totalDistanceKm: 0, estimatedTravelMinutes: 0, warnings: [] });
  assert.match(ngoOrigin.originLabel, /saved location/i);
  assert.match(firstStopOrigin.originLabel, /no saved organization location/i);
});

test('buildRouteView shapes each stop with a status label and badge class', () => {
  const route = {
    routeId: 'r1',
    origin: { type: 'NGO', latitude: 1, longitude: 2 },
    stops: [
      { sequence: 1, listingId: 10, distanceFromPreviousKm: 2, cumulativeDistanceKm: 2, estimatedArrivalTime: '2026-01-01T10:00:00.000Z', safeUntilTime: '2026-01-01T12:00:00.000Z', timeStatus: 'SAFE', quantity: 5 },
      { sequence: 2, listingId: 11, distanceFromPreviousKm: 3, cumulativeDistanceKm: 5, estimatedArrivalTime: '2026-01-01T10:30:00.000Z', safeUntilTime: '2026-01-01T10:35:00.000Z', timeStatus: 'AT_RISK', quantity: 3 },
    ],
    totalDistanceKm: 5,
    estimatedTravelMinutes: 12,
    warnings: [{ listingId: 11, message: 'Stop #2 is at risk.' }],
  };
  const view = buildRouteView(route);
  assert.equal(view.stops[0].statusLabel, 'On track');
  assert.equal(view.stops[0].badgeClass, 'badge-success');
  assert.equal(view.stops[0].warningMessage, null);
  assert.equal(view.stops[1].statusLabel, 'At risk of running late');
  assert.equal(view.stops[1].warningMessage, 'Stop #2 is at risk.');
});

test('buildRouteView separates a listing-level warning that never became a stop (e.g. missing coordinates)', () => {
  const route = {
    routeId: 'r1',
    origin: { type: 'NGO', latitude: 1, longitude: 2 },
    stops: [
      { sequence: 1, listingId: 10, distanceFromPreviousKm: 0, cumulativeDistanceKm: 0, estimatedArrivalTime: 't', safeUntilTime: 't', timeStatus: 'SAFE', quantity: 5 },
    ],
    totalDistanceKm: 0,
    estimatedTravelMinutes: 0,
    warnings: [{ listingId: 99, message: 'Listing 99 has no kitchen location on file and was excluded from the route.' }],
  };
  const view = buildRouteView(route);
  assert.equal(view.stops[0].warningMessage, null);
  assert.deepEqual(view.routeLevelWarnings, ['Listing 99 has no kitchen location on file and was excluded from the route.']);
});

test('buildRouteView flags an empty route (e.g. every selected listing was excluded)', () => {
  const view = buildRouteView({ routeId: 'r1', origin: null, stops: [], totalDistanceKm: 0, estimatedTravelMinutes: 0, warnings: [{ listingId: 1, message: 'excluded' }] });
  assert.equal(view.isEmpty, true);
  assert.equal(view.originLabel, 'No stops to route');
  assert.deepEqual(view.routeLevelWarnings, ['excluded']);
});

test('buildRouteView passes through distance and travel-time totals unchanged (never re-derives them)', () => {
  const view = buildRouteView({ routeId: 'r1', origin: { type: 'NGO', latitude: 1, longitude: 2 }, stops: [], totalDistanceKm: 12.34, estimatedTravelMinutes: 45, warnings: [] });
  assert.equal(view.totalDistanceKm, 12.34);
  assert.equal(view.estimatedTravelMinutes, 45);
});
