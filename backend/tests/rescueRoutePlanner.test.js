const { planRoute, classifyTimeStatus } = require('../src/ai/rescueRoutePlanner');
const { haversineDistanceKm } = require('../src/utils/distance');

const CONFIG = { averageSpeedKmh: 25, pickupServiceMinutes: 10, atRiskBufferMinutes: 30, urgencyTieBreakMinutes: 45 };
const START = new Date('2026-01-01T10:00:00.000Z');

function stop(listingId, latitude, longitude, safeUntilTime, quantity = 5) {
    return { listingId, latitude, longitude, safeUntilTime, quantity };
}

describe('rescueRoutePlanner - Haversine distance usage', () => {
    it('a stop\'s distanceFromPreviousKm from the NGO origin equals the shared Haversine utility\'s own output', () => {
        const origin = { type: 'NGO', latitude: 18.52, longitude: 73.85 };
        const s1 = stop(1, 18.55, 73.9, '2026-01-01T20:00:00.000Z');
        const result = planRoute({ origin, stops: [s1], routeStartTime: START, config: CONFIG });

        const expected = Math.round(haversineDistanceKm(18.52, 73.85, 18.55, 73.9) * 100) / 100;
        expect(result.stops[0].distanceFromPreviousKm).toBe(expected);
    });

    it('zero distance when two consecutive points are identical', () => {
        const origin = { type: 'NGO', latitude: 10, longitude: 20 };
        const s1 = stop(1, 10, 20, '2026-01-01T20:00:00.000Z');
        const result = planRoute({ origin, stops: [s1], routeStartTime: START, config: CONFIG });
        expect(result.stops[0].distanceFromPreviousKm).toBe(0);
        expect(result.totalDistanceKm).toBe(0);
    });
});

describe('rescueRoutePlanner - deterministic nearest-neighbor + urgency sequencing', () => {
    // Mirrors the Task 18 example: B is both nearest and most urgent, so every rule agrees on B first.
    it('sequences by nearest-and-most-urgent when distance and urgency agree (the worked example)', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const listingB = stop('B', 0.02, 0, '2026-01-01T17:45:00.000Z'); // nearest, earliest deadline
        const listingA = stop('A', 0.04, 0, '2026-01-01T18:30:00.000Z');
        const listingC = stop('C', 0.06, 0, '2026-01-01T19:15:00.000Z'); // farthest, latest deadline

        const result = planRoute({ origin, stops: [listingA, listingB, listingC], routeStartTime: START, config: CONFIG });
        expect(result.stops.map((s) => s.listingId)).toEqual(['B', 'A', 'C']);
        expect(result.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    });

    it('prefers the materially more urgent stop over the nearer one (urgency overrides distance)', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        // "near" is closer to the origin but its deadline is hours later; "urgent" is farther but expires soon.
        const near = stop('near', 0.01, 0, '2026-01-01T23:00:00.000Z');
        const urgent = stop('urgent', 0.5, 0, '2026-01-01T10:30:00.000Z'); // only 30 min after routeStartTime

        const result = planRoute({ origin, stops: [near, urgent], routeStartTime: START, config: CONFIG });
        expect(result.stops[0].listingId).toBe('urgent');
        expect(result.stops[1].listingId).toBe('near');
    });

    it('falls back to nearest-stop when urgency is only marginally different (within the tie-break window)', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const near = stop('near', 0.01, 0, '2026-01-01T18:00:00.000Z');
        const slightlyEarlier = stop('slightlyEarlier', 0.5, 0, '2026-01-01T17:50:00.000Z'); // only 10 min earlier

        const result = planRoute({ origin, stops: [near, slightlyEarlier], routeStartTime: START, config: CONFIG });
        expect(result.stops[0].listingId).toBe('near');
    });

    it('breaks an exact distance-and-urgency tie deterministically by ascending listing id', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const s5 = stop(5, 0.02, 0, '2026-01-01T18:00:00.000Z');
        const s2 = stop(2, 0.02, 0, '2026-01-01T18:00:00.000Z'); // identical position and deadline, lower id

        const result = planRoute({ origin, stops: [s5, s2], routeStartTime: START, config: CONFIG });
        expect(result.stops.map((s) => s.listingId)).toEqual([2, 5]);
    });

    it('is deterministic: running the same input twice produces the exact same sequence', () => {
        const origin = { type: 'NGO', latitude: 12.9, longitude: 77.6 };
        const stops = [
            stop(3, 12.95, 77.65, '2026-01-01T20:00:00.000Z'),
            stop(1, 12.91, 77.61, '2026-01-01T18:00:00.000Z'),
            stop(2, 13.0, 77.7, '2026-01-01T19:00:00.000Z'),
        ];
        const first = planRoute({ origin, stops, routeStartTime: START, config: CONFIG });
        const second = planRoute({ origin, stops: [...stops].reverse(), routeStartTime: START, config: CONFIG });
        expect(first.stops.map((s) => s.listingId)).toEqual(second.stops.map((s) => s.listingId));
    });
});

describe('rescueRoutePlanner - cumulative and total distance', () => {
    it('cumulative distance accumulates leg by leg and matches the sum of individual legs', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const s1 = stop(1, 0.01, 0, '2026-01-02T00:00:00.000Z');
        const s2 = stop(2, 0.02, 0, '2026-01-02T00:00:00.000Z');
        const result = planRoute({ origin, stops: [s1, s2], routeStartTime: START, config: CONFIG });

        const [leg1, leg2] = result.stops;
        expect(leg1.cumulativeDistanceKm).toBe(leg1.distanceFromPreviousKm);
        expect(leg2.cumulativeDistanceKm).toBeCloseTo(leg1.distanceFromPreviousKm + leg2.distanceFromPreviousKm, 2);
        expect(result.totalDistanceKm).toBeCloseTo(leg2.cumulativeDistanceKm, 5);
    });
});

describe('rescueRoutePlanner - estimated travel time and configurable speed', () => {
    it('estimated travel time equals total distance divided by the configured average speed', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const s1 = stop(1, 0.5, 0, '2026-01-02T00:00:00.000Z');
        const result = planRoute({ origin, stops: [s1], routeStartTime: START, config: CONFIG });

        const expectedMinutes = Math.round((result.totalDistanceKm / CONFIG.averageSpeedKmh) * 60);
        expect(result.estimatedTravelMinutes).toBe(expectedMinutes);
        expect(result.travelTimeType).toBe('ESTIMATED_STRAIGHT_LINE');
    });

    it('a faster configured speed produces a shorter estimated travel time for the same distance', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const s1 = stop(1, 0.5, 0, '2026-01-02T00:00:00.000Z');
        const slow = planRoute({ origin, stops: [s1], routeStartTime: START, config: { ...CONFIG, averageSpeedKmh: 10 } });
        const fast = planRoute({ origin, stops: [s1], routeStartTime: START, config: { ...CONFIG, averageSpeedKmh: 50 } });
        expect(fast.estimatedTravelMinutes).toBeLessThan(slow.estimatedTravelMinutes);
    });
});

describe('rescueRoutePlanner - origin handling', () => {
    it('uses the NGO\'s own coordinates as the origin when available', () => {
        const origin = { type: 'NGO', latitude: 18.52, longitude: 73.85 };
        const s1 = stop(1, 18.6, 73.9, '2026-01-02T00:00:00.000Z');
        const result = planRoute({ origin, stops: [s1], routeStartTime: START, config: CONFIG });
        expect(result.origin).toEqual({ type: 'NGO', latitude: 18.52, longitude: 73.85 });
    });

    it('falls back to FIRST_STOP and never invents a coordinate when the NGO has none', () => {
        const origin = { type: 'FIRST_STOP' };
        const s1 = stop(1, 18.6, 73.9, '2026-01-02T00:00:00.000Z');
        const s2 = stop(2, 18.7, 74.0, '2026-01-02T01:00:00.000Z');
        const result = planRoute({ origin, stops: [s1, s2], routeStartTime: START, config: CONFIG });

        expect(result.origin.type).toBe('FIRST_STOP');
        const firstSequencedStop = result.stops[0];
        expect(result.origin.latitude).toBe(firstSequencedStop.latitude);
        expect(result.origin.longitude).toBe(firstSequencedStop.longitude);
        expect(firstSequencedStop.distanceFromPreviousKm).toBe(0);
        expect(firstSequencedStop.cumulativeDistanceKm).toBe(0);
    });

    it('returns an empty, well-formed result for zero stops', () => {
        const result = planRoute({ origin: { type: 'FIRST_STOP' }, stops: [], routeStartTime: START, config: CONFIG });
        expect(result.stops).toEqual([]);
        expect(result.totalDistanceKm).toBe(0);
        expect(result.estimatedTravelMinutes).toBe(0);
        expect(result.origin).toBe(null);
        expect(result.warnings).toEqual([]);
    });
});

describe('rescueRoutePlanner / classifyTimeStatus - food-safety time feasibility', () => {
    it('SAFE when arrival is comfortably before the buffer window', () => {
        const arrival = new Date('2026-01-01T10:00:00.000Z');
        const safeUntil = new Date('2026-01-01T12:00:00.000Z'); // 2 hours of slack, buffer is 30 min
        expect(classifyTimeStatus(arrival, safeUntil, 30)).toBe('SAFE');
    });

    it('AT_RISK when arrival falls inside the buffer window but not past the deadline', () => {
        const arrival = new Date('2026-01-01T11:45:00.000Z');
        const safeUntil = new Date('2026-01-01T12:00:00.000Z'); // 15 min of slack, buffer is 30 min
        expect(classifyTimeStatus(arrival, safeUntil, 30)).toBe('AT_RISK');
    });

    it('EXPIRED_BY_ESTIMATE when the estimated arrival is after the safe-until time', () => {
        const arrival = new Date('2026-01-01T12:30:00.000Z');
        const safeUntil = new Date('2026-01-01T12:00:00.000Z');
        expect(classifyTimeStatus(arrival, safeUntil, 30)).toBe('EXPIRED_BY_ESTIMATE');
    });

    it('the exact safe-until boundary (zero slack) is AT_RISK, not EXPIRED', () => {
        const safeUntil = new Date('2026-01-01T12:00:00.000Z');
        expect(classifyTimeStatus(safeUntil, safeUntil, 30)).toBe('AT_RISK');
    });

    it('the exact edge of the at-risk buffer is still AT_RISK (boundary is inclusive)', () => {
        const safeUntil = new Date('2026-01-01T12:00:00.000Z');
        const arrival = new Date(safeUntil.getTime() - 30 * 60 * 1000);
        expect(classifyTimeStatus(arrival, safeUntil, 30)).toBe('AT_RISK');
    });

    it('one minute inside the buffer boundary is still SAFE', () => {
        const safeUntil = new Date('2026-01-01T12:00:00.000Z');
        const arrival = new Date(safeUntil.getTime() - 31 * 60 * 1000);
        expect(classifyTimeStatus(arrival, safeUntil, 30)).toBe('SAFE');
    });

    it('cumulative travel time across multiple stops can push a later stop into AT_RISK/EXPIRED even with a generous individual deadline', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        // Each leg is ~55.5 km (0.5 degrees) so at 25 km/h that is well over an hour of travel per leg.
        const s1 = stop(1, 0.5, 0, '2026-01-01T12:00:00.000Z');
        const s2 = stop(2, 1.0, 0, '2026-01-01T12:30:00.000Z'); // looks fine in isolation, but arrives late in sequence

        const result = planRoute({ origin, stops: [s1, s2], routeStartTime: START, config: CONFIG });
        const secondStop = result.stops.find((s) => s.listingId === 2);
        expect(['AT_RISK', 'EXPIRED_BY_ESTIMATE']).toContain(secondStop.timeStatus);
        expect(result.warnings.some((w) => w.listingId === 2)).toBe(true);
    });

    it('a stop kept visible even when EXPIRED_BY_ESTIMATE - never silently dropped', () => {
        const origin = { type: 'NGO', latitude: 0, longitude: 0 };
        const hopeless = stop(1, 5, 0, '2026-01-01T10:05:00.000Z'); // far away, deadline minutes from routeStartTime
        const result = planRoute({ origin, stops: [hopeless], routeStartTime: START, config: CONFIG });
        expect(result.stops).toHaveLength(1);
        expect(result.stops[0].timeStatus).toBe('EXPIRED_BY_ESTIMATE');
    });
});
