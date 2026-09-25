import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wasteChange,
  estimateLossAvoided,
  rescueOpportunities,
  rescuePipeline,
  highRiskFood,
  priorityBreakdown,
  feedSummary,
  notificationActivity,
  organizationCounts,
} from './metrics.js';
import { addDays, dateString, formatInr, formatMinutes, minutesUntil } from './format.js';
import { combine } from './useResource.js';

const NOW = Date.parse('2026-09-21T10:00:00Z');
const minutesFromNow = (m) => new Date(NOW + m * 60000).toISOString();
const totals = (logCount, preparedQuantity, wasteQuantity) => ({
  totals: { logCount, preparedQuantity, wasteQuantity, wastePercentage: preparedQuantity ? Math.round((wasteQuantity / preparedQuantity) * 1000) / 10 : null },
});

test('wasteChange compares waste RATES of two periods', () => {
  const result = wasteChange(totals(7, 700, 70), totals(7, 500, 100)); // 10% now vs 20% before
  assert.equal(result.state, 'ready');
  assert.equal(result.rateNow, 10);
  assert.equal(result.ratePrevious, 20);
  assert.equal(result.changePct, -50);
  assert.equal(result.direction, 'down');
});

test('wasteChange reports an increase and a flat result', () => {
  assert.equal(wasteChange(totals(5, 100, 30), totals(5, 100, 10)).direction, 'up');
  assert.equal(wasteChange(totals(5, 100, 10), totals(5, 100, 10)).direction, 'flat');
});

test('wasteChange refuses to guess without logs in BOTH periods', () => {
  assert.equal(wasteChange(totals(0, 0, 0), totals(4, 100, 10)).state, 'insufficient');
  assert.equal(wasteChange(totals(4, 100, 10), totals(0, 0, 0)).state, 'insufficient');
  assert.equal(wasteChange(null, null).state, 'insufficient');
  assert.match(wasteChange(totals(4, 100, 10), totals(0, 0, 0)).reason, /previous/);
});

test('wasteChange handles a previous period with no waste without dividing by zero', () => {
  const up = wasteChange(totals(4, 100, 10), totals(4, 100, 0));
  assert.deepEqual([up.state, up.changePct, up.direction], ['ready', null, 'up']);
  assert.equal(wasteChange(totals(4, 100, 0), totals(4, 100, 0)).direction, 'flat');
});

test('estimateLossAvoided values only approved recommendations that have an actual, at the item cost', () => {
  const items = [
    { menuItemId: 1, managerAction: 'approved', originalPlannedQuantity: 150, actual: { preparedQuantity: 112 } }, // 38 avoided
    { menuItemId: 1, managerAction: 'approved', originalPlannedQuantity: 100, actual: { preparedQuantity: 120 } }, // prepared more: 0, never negative
    { menuItemId: 1, managerAction: 'rejected', originalPlannedQuantity: 200, actual: { preparedQuantity: 100 } }, // not approved
    { menuItemId: 1, managerAction: 'approved', originalPlannedQuantity: 90, actual: null }, // no outcome yet
    { menuItemId: 2, managerAction: 'approved', originalPlannedQuantity: 50, actual: { preparedQuantity: 40 } }, // 10 avoided, no cost known
  ];
  const menu = [{ id: 1, cost_per_unit: 45, preparation_cost_per_unit: 8 }, { id: 2, cost_per_unit: 0, preparation_cost_per_unit: 0 }];
  const result = estimateLossAvoided(items, menu);
  assert.equal(result.counted, 3);
  assert.equal(result.totalUnits, 48);
  assert.equal(result.totalValue, 38 * 53);
  assert.equal(result.withoutCost, 1);
});

test('estimateLossAvoided is empty, not invented, without data', () => {
  assert.deepEqual(estimateLossAvoided([], []), { counted: 0, totalUnits: 0, totalValue: 0, withoutCost: 0 });
  assert.deepEqual(estimateLossAvoided(undefined, undefined), { counted: 0, totalUnits: 0, totalValue: 0, withoutCost: 0 });
});

test('rescueOpportunities counts only available, unexpired listings', () => {
  const listings = [
    { status: 'Available', quantity: 12, safe_until_time: minutesFromNow(90) },
    { status: 'Available', quantity: 8, safe_until_time: minutesFromNow(300) },
    { status: 'Available', quantity: 5, safe_until_time: minutesFromNow(-10) }, // expired but not yet swept
    { status: 'Claimed', quantity: 9, safe_until_time: minutesFromNow(200) },
  ];
  const result = rescueOpportunities(listings, NOW);
  assert.deepEqual(result, { count: 2, quantity: 20, soonestMinutes: 90, urgentCount: 1 });
  assert.deepEqual(rescueOpportunities([], NOW), { count: 0, quantity: 0, soonestMinutes: null, urgentCount: 0 });
});

test('rescuePipeline groups recent listings by status and names the NGO from the directory', () => {
  const listings = [
    { id: 1, status: 'Available', quantity: 5, created_at: minutesFromNow(-60) },
    { id: 2, status: 'Claimed', quantity: 12, created_at: minutesFromNow(-120), claimed_by_ngo_id: 7, confirmed_pickup_time: null, food_type: 'Rice' },
    { id: 3, status: 'Claimed', quantity: 4, created_at: minutesFromNow(-120), claimed_by_ngo_id: 8, confirmed_pickup_time: minutesFromNow(30), food_type: 'Dal' },
    { id: 4, status: 'Collected', quantity: 10, created_at: minutesFromNow(-60 * 24 * 3) },
    { id: 5, status: 'Collected', quantity: 99, created_at: minutesFromNow(-60 * 24 * 60) }, // outside the 30-day window
  ];
  const result = rescuePipeline(listings, [{ id: 7, name: 'Seva Food Bank' }], { now: NOW });
  assert.equal(result.total, 4);
  assert.deepEqual([result.available, result.claimed, result.collected, result.expired], [1, 2, 1, 0]);
  assert.equal(result.collectedQuantity, 10);
  assert.deepEqual(result.awaitingConfirmation, [{ id: 2, food: 'Rice', quantity: 12, ngo: 'Seva Food Bank' }]);
  assert.equal(result.awaitingCollection[0].ngo, 'An NGO'); // unknown NGO id: never a made-up name
});

test('highRiskFood combines spoilage risk and repeated over-preparation, most severe first', () => {
  const patterns = { recurringOverPreparation: [{ menuItemId: 3, menuItemName: 'Veg Thali', recentLogCount: 5, overPreparedLogCount: 4, averageWastePercentage: 12.8 }] };
  const spoilage = [
    { listing: { id: 1, food_type: 'Rice' }, assessment: { riskLevel: 'LOW', minutesRemaining: 200 } },
    { listing: { id: 2, food_type: 'Curry' }, assessment: { riskLevel: 'HIGH', minutesRemaining: 25 } },
    { listing: { id: 3, food_type: 'Dal' }, assessment: { riskLevel: 'MEDIUM', minutesRemaining: 80 } },
  ];
  const result = highRiskFood(patterns, spoilage);
  assert.deepEqual(result.map((r) => r.key), ['spoil-2', 'spoil-3', 'prep-3']);
  assert.match(result[0].detail, /high spoilage risk, 25 min left/);
  assert.match(result[2].detail, /4 of its last 5 logs, about 12.8% left over/);
  assert.deepEqual(highRiskFood({ recurringOverPreparation: [] }, []), []);
  assert.deepEqual(highRiskFood(undefined, undefined), []);
});

test('priorityBreakdown, feedSummary, notificationActivity and organizationCounts summarise real lists', () => {
  const priority = priorityBreakdown([{ priorityLevel: 'CRITICAL' }, { priorityLevel: 'HIGH' }, { priorityLevel: 'CRITICAL' }, { priorityLevel: 'LOW' }]);
  assert.deepEqual([priority.total, priority.critical, priority.high, priority.low, priority.top.length], [4, 2, 1, 1, 3]);

  const feed = feedSummary([
    { quantity: 12, distance_km: 3.4, safe_until_time: minutesFromNow(100) },
    { quantity: 5, distance_km: null, safe_until_time: minutesFromNow(400) },
  ], NOW);
  assert.deepEqual(feed, { count: 2, quantity: 17, nearestKm: 3.4, soonestMinutes: 100 });
  assert.deepEqual(feedSummary([], NOW), { count: 0, quantity: 0, nearestKm: null, soonestMinutes: null });

  const activity = notificationActivity([
    { type: 'PICKUP_CONFIRMED', is_read: false }, { type: 'LISTING_COLLECTED', is_read: true }, { type: 'SURPLUS_POSTED', is_read: false },
  ]);
  assert.deepEqual([activity.total, activity.unread, activity.pickupsConfirmed, activity.collections, activity.newSurplus], [3, 2, 1, 1, 1]);

  const orgs = organizationCounts([
    { type: 'kitchen' }, { type: 'ngo', verification_status: 'verified' }, { type: 'ngo', verification_status: 'pending' }, { type: 'ngo', verification_status: 'rejected' },
  ]);
  assert.deepEqual(orgs, { total: 4, kitchens: 1, ngos: 3, verifiedNgos: 1, pendingNgos: 1, rejectedNgos: 1 });
});

test('date and number formatting helpers', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dateString(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(formatInr(123456), '₹1,23,456');
  assert.equal(formatMinutes(125), '2 h 5 min');
  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(0), 'expired');
  assert.equal(formatMinutes(null), '—');
  assert.equal(minutesUntil('2026-09-21T10:30:00Z', NOW), 30);
});

test('combine reports loading, then error, then derived data', () => {
  const ready = (data) => ({ status: 'ready', data, reload: () => {} });
  assert.equal(combine([ready(1), { status: 'loading' }], () => 0).status, 'loading');
  const failed = combine([ready(1), { status: 'error', error: 'boom', reload: () => {} }], () => 0);
  assert.deepEqual([failed.status, failed.error], ['error', 'boom']);
  const done = combine([ready(2), ready(3)], (a, b) => a + b);
  assert.deepEqual([done.status, done.data], ['ready', 5]);
});
