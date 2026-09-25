const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');
const { calculatePriorities } = require('../src/ai/rescuePriority');

// Mock external dependencies
jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));

// Rescue Priority now runs on the standard authenticate middleware (same as every
// other hardened route). For these fast, fully-mocked-db tests we stand in for
// authenticate the same way processing.test.js/learning.test.js do. The route itself still enforces its own rules
// (NGO roles + system admin only, and the NGO must be verified), which is why the first query below is the NGO lookup.
jest.mock('../src/middleware/authenticate', () => {
    return (req, res, next) => {
        if (!req.headers['x-mock-role']) {
            return res.status(401).json({ status: 'error', message: 'Authentication token missing or malformed' });
        }
        req.user = {
            id: 1,
            name: 'Rescue Priority Test User',
            email: 'rescue@example.com',
            role: req.headers['x-mock-role'],
            organizationId: req.headers['x-mock-org-id'] ? parseInt(req.headers['x-mock-org-id'], 10) : 1,
        };
        next();
    };
});

describe('Rescue Priority Service Logic', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers().setSystemTime(new Date('2026-09-16T10:00:00Z'));
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('should assign CRITICAL to listing expiring in < 2 hours with score >= 80', () => {
        const listings = [
            { id: 1, quantity: 40, safe_until_time: '2026-09-16T11:00:00Z' } // 1 hour left
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].priorityLevel).toBe('CRITICAL');
        expect(result[0].urgencyScore).toBe(100);
        // 40 kg / 0.4 = 100 meals = 100 impact
        // priority = (100 * 0.6) + (100 * 0.4) = 100
        expect(result[0].priorityScore).toBe(100);
    });

    it('should assign CRITICAL simply for being < 2 hours even if quantity is small', () => {
        const listings = [
            { id: 1, quantity: 4, safe_until_time: '2026-09-16T11:30:00Z' } // 1.5 hours left
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].priorityLevel).toBe('CRITICAL');
        expect(result[0].urgencyScore).toBe(100);
        // 4 kg / 0.4 = 10 meals = 10 impact
        // priority = (100 * 0.6) + (10 * 0.4) = 64
        // Score is 64 (HIGH), but time < 2 hours bumps it to CRITICAL
    });

    it('should assign HIGH to listing with good quantity but safe for a few hours', () => {
        const listings = [
            { id: 1, quantity: 30, safe_until_time: '2026-09-16T15:00:00Z' } // 5 hours left
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].priorityLevel).toBe('HIGH');
        // 5 hours = 300 mins. urgency = 70.
        // impact = 30 / 0.4 = 75 meals. priority = (70 * 0.6) + (75 * 0.4) = 42 + 30 = 72 (HIGH)
    });

    it('should handle zero/expired correctly (filters it out essentially)', () => {
        const listings = [
            { id: 1, quantity: 40, safe_until_time: '2026-09-16T09:00:00Z' } // 1 hour past
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].priorityScore).toBe(0);
        expect(result[0].priorityLevel).toBe('LOW');
        expect(result[0].reason).toBe('Expired');
    });

    it('should handle missing safe_until_time', () => {
        const listings = [
            { id: 1, quantity: 40, safe_until_time: null } 
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].priorityScore).toBe(0);
        expect(result[0].priorityLevel).toBe('LOW');
    });

    it('should handle zero or invalid quantity', () => {
        const listings = [
            { id: 1, quantity: 0, safe_until_time: '2026-09-16T15:00:00Z' },
            { id: 2, quantity: -5, safe_until_time: '2026-09-16T15:00:00Z' },
            { id: 3, quantity: null, safe_until_time: '2026-09-16T15:00:00Z' }
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].impactScore).toBe(0);
        expect(result[1].impactScore).toBe(0);
        expect(result[2].impactScore).toBe(0);
    });

    it('should sort listings descending by priority score', () => {
        const listings = [
            { id: 1, quantity: 4, safe_until_time: '2026-09-16T20:00:00Z' }, // Low
            { id: 2, quantity: 40, safe_until_time: '2026-09-16T11:00:00Z' }, // Critical
            { id: 3, quantity: 10, safe_until_time: '2026-09-16T15:00:00Z' }, // Medium
        ];
        const result = calculatePriorities(listings);
        
        expect(result[0].id).toBe(2);
        expect(result[1].id).toBe(3);
        expect(result[2].id).toBe(1);
    });
});

describe('Rescue Priority API Endpoint', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('GET /api/rescue-priorities should return sorted listings', async () => {
        // The route first loads the calling NGO (it must be verified), then the available listings.
        pool.query.mockResolvedValueOnce({ rows: [{ id: 2, type: 'ngo', verification_status: 'verified', latitude: null, longitude: null, service_radius_km: null }] });
        // Mock DB returning some available listings
        pool.query.mockResolvedValueOnce({
            rows: [
                { id: 1, quantity: 40, safe_until_time: new Date(Date.now() + 60*60*1000).toISOString(), status: 'Available' } // 1 hour
            ]
        }).mockResolvedValueOnce({}); // Ignore the insert

        const res = await request(app)
            .get('/api/rescue-priorities')
            .set('x-mock-role', 'NGO_COORDINATOR')
            .set('x-mock-org-id', '2');
        
        expect(res.statusCode).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].priorityLevel).toBe('CRITICAL');
    });

    it('should block unauthorized access', async () => {
        const res = await request(app)
            .get('/api/rescue-priorities');
            // No auth headers
        
        expect(res.statusCode).toBe(401);
    });
});
