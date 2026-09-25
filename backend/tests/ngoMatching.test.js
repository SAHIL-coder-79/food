const request = require('supertest');
const { scoreNgoMatches, getRankedMatches } = require('../src/ai/ngoMatching');

// Mock external dependencies for the pure-scoring / async-wrapper unit tests below.
jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn(),
}));
const pool = require('../src/models/db');

describe('NGO match scoring (pure)', () => {
    const now = new Date('2026-09-16T10:00:00Z');
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(now);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    const baseListing = {
        id: 1,
        quantity: 20,
        food_type: 'Rice and Curry',
        safe_until_time: '2026-09-16T11:30:00Z', // 1.5h remaining -> critical urgency
    };

    it('ranks a close, well-stocked, reliable NGO above a far, mismatched one', () => {
        const goodNgo = {
            id: 1,
            name: 'Good NGO',
            distance_km: 1,
            capacity_kg: 25,
            preferred_food_types: ['Rice and Curry'],
            completed_pickups: 15,
            avg_response_minutes: 15,
        };
        const badNgo = {
            id: 2,
            name: 'Far NGO',
            distance_km: 30,
            capacity_kg: 5,
            preferred_food_types: ['Fruits'],
            completed_pickups: 20,
            avg_response_minutes: 300,
        };

        const result = scoreNgoMatches(baseListing, [badNgo, goodNgo]);

        expect(result[0].ngoOrgId).toBe(1);
        expect(result[1].ngoOrgId).toBe(2);
        expect(result[0].matchScore).toBeGreaterThan(result[1].matchScore);
        expect(result[0].matchMethod).toBe('scored');
        expect(typeof result[0].reason).toBe('string');
        expect(result[0].reason.length).toBeGreaterThan(0);
    });

    it('never recommends an expired listing', () => {
        const result = scoreNgoMatches(
            { ...baseListing, safe_until_time: '2026-09-16T09:00:00Z' }, // 1h in the past
            [{ id: 1, distance_km: 1, capacity_kg: 25, completed_pickups: 10, avg_response_minutes: 10 }]
        );
        expect(result).toEqual([]);
    });

    it('handles a missing safe_until_time with neutral urgency instead of excluding the NGO', () => {
        const result = scoreNgoMatches(
            { ...baseListing, safe_until_time: null },
            [{ id: 1, distance_km: 1, capacity_kg: 25, completed_pickups: 10, avg_response_minutes: 10 }]
        );
        expect(result).toHaveLength(1);
        expect(result[0].supportingMetrics.urgency_score).toBe(50);
    });

    it('gives a new NGO with no pickup history a neutral reliability score, not zero', () => {
        const result = scoreNgoMatches(baseListing, [
            { id: 1, distance_km: 1, capacity_kg: 25, completed_pickups: 0, avg_response_minutes: null },
        ]);
        expect(result[0].supportingMetrics.reliability_score).toBe(50);
    });

    it('scores a category mismatch lower than a match, without excluding the NGO', () => {
        const matching = scoreNgoMatches(baseListing, [
            { id: 1, distance_km: 5, capacity_kg: 25, preferred_food_types: ['Rice and Curry'], completed_pickups: 0 },
        ])[0];
        const mismatched = scoreNgoMatches(baseListing, [
            { id: 2, distance_km: 5, capacity_kg: 25, preferred_food_types: ['Fruits'], completed_pickups: 0 },
        ])[0];
        expect(matching.supportingMetrics.category_score).toBeGreaterThan(mismatched.supportingMetrics.category_score);
    });

    it('treats an NGO with no configured preferences as accepting all categories', () => {
        const result = scoreNgoMatches(baseListing, [
            { id: 1, distance_km: 5, capacity_kg: 25, preferred_food_types: null, completed_pickups: 0 },
        ]);
        expect(result[0].supportingMetrics.category_score).toBe(100);
    });

    it('lowers the capacity score when the NGO cannot take the full quantity', () => {
        const result = scoreNgoMatches(baseListing, [
            { id: 1, distance_km: 5, capacity_kg: 5, completed_pickups: 0 }, // 5kg capacity vs 20kg listing
        ]);
        expect(result[0].supportingMetrics.capacity_score).toBeLessThan(100);
    });

    it('handles missing distance (no coordinates) with a neutral distance score', () => {
        const result = scoreNgoMatches(baseListing, [
            { id: 1, distance_km: null, capacity_kg: 25, completed_pickups: 0 },
        ]);
        expect(result[0].distanceKm).toBeNull();
        expect(result[0].supportingMetrics.distance_score).toBe(50);
    });

    it('sorts multiple candidates by matchScore descending', () => {
        const result = scoreNgoMatches(baseListing, [
            { id: 1, distance_km: 20, capacity_kg: 5, completed_pickups: 0 }, // weak
            { id: 2, distance_km: 1, capacity_kg: 25, preferred_food_types: ['Rice and Curry'], completed_pickups: 15, avg_response_minutes: 10 }, // strong
            { id: 3, distance_km: 10, capacity_kg: 15, completed_pickups: 5, avg_response_minutes: 60 }, // medium
        ]);
        const scores = result.map((r) => r.matchScore);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        expect(result[0].ngoOrgId).toBe(2);
    });
});

describe('getRankedMatches (async wrapper + fallback)', () => {
    const kitchenOrg = { id: 100, latitude: 12.9, longitude: 77.6 };
    const listing = {
        id: 1,
        quantity: 20,
        food_type: 'Rice and Curry',
        safe_until_time: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        kitchen_org_id: 100,
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns an empty array when no verified NGOs are in range', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // organizations query
        const result = await getRankedMatches(listing, kitchenOrg);
        expect(result).toEqual([]);
    });

    it('returns scored matches when everything succeeds', async () => {
        pool.query
            .mockResolvedValueOnce({
                rows: [{ id: 1, name: 'NGO A', latitude: 12.91, longitude: 77.61, service_radius_km: null, capacity_kg: 25, preferred_food_types: ['Rice and Curry'] }],
            }) // organizations query
            .mockResolvedValueOnce({ rows: [{ ngo_org_id: 1, completed_pickups: '10', avg_response_minutes: '20' }] }) // reliability stats
            .mockResolvedValueOnce({}); // insert into ai_ngo_match_scores

        const result = await getRankedMatches(listing, kitchenOrg);
        expect(result).toHaveLength(1);
        expect(result[0].matchMethod).toBe('scored');
        expect(result[0].matchScore).toBeGreaterThan(0);
    });

    it('falls back to radius/distance ordering when scoring fails', async () => {
        pool.query
            .mockResolvedValueOnce({
                rows: [
                    { id: 1, name: 'Near NGO', latitude: 12.91, longitude: 77.61, service_radius_km: null, capacity_kg: 25 },
                    { id: 2, name: 'Far NGO', latitude: 13.5, longitude: 78.2, service_radius_km: null, capacity_kg: 25 },
                ],
            }) // organizations query
            .mockRejectedValueOnce(new Error('DB unavailable')); // reliability stats query fails

        const result = await getRankedMatches(listing, kitchenOrg);

        expect(result).toHaveLength(2);
        expect(result.every((m) => m.matchMethod === 'radius_fallback')).toBe(true);
        expect(result[0].ngoOrgId).toBe(1); // nearer NGO ranked first by distance
        expect(result[0].matchScore).toBeNull();
    });
});

