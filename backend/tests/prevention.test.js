const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');
const { predictDemand } = require('../src/ai/forecasting');
const { generatePreventionRecommendation, updateRecommendationStatus } = require('../src/ai/prevention');

// Mock external dependencies
jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));
jest.mock('../src/ai/forecasting');

// Prevention now runs on the standard authenticate/authorize middleware (same as
// every other hardened route). For these fast, fully-mocked-db tests we stand in
// for authenticate the same way processing.test.js/learning.test.js do, driven by
// x-mock-role/x-mock-org-id headers - authorize() itself runs for real.
jest.mock('../src/middleware/authenticate', () => {
    return (req, res, next) => {
        if (!req.headers['x-mock-role']) {
            return res.status(401).json({ status: 'error', message: 'Authentication token missing or malformed' });
        }
        req.user = {
            id: 1,
            name: 'Prevention Test User',
            email: 'prevention@example.com',
            role: req.headers['x-mock-role'],
            organizationId: req.headers['x-mock-org-id'] ? parseInt(req.headers['x-mock-org-id'], 10) : 1,
        };
        next();
    };
});

describe('Prevention Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return LOW risk if excess <= 5%', async () => {
        predictDemand.mockResolvedValueOnce({
            predictedQuantity: 100,
            confidenceScore: 0.8,
            keyFactors: {}
        });

        // Mock the history query
        pool.query.mockResolvedValueOnce({ rows: [] });

        const result = await generatePreventionRecommendation(1, '2026-09-17', 105, 1);
        expect(result.riskLevel).toBe('LOW');
        expect(result.excess).toBe(5);
        expect(pool.query).toHaveBeenCalledTimes(1); // Only history query, no insert
    });

    it('should return MEDIUM risk and create pending recommendation if excess > 5% and <= 15%', async () => {
        predictDemand.mockResolvedValueOnce({
            predictedQuantity: 100,
            confidenceScore: 0.8,
            keyFactors: {}
        });
        // 1st query: history, 2nd query: insert
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await generatePreventionRecommendation(1, '2026-09-17', 110, 1);
        expect(result.riskLevel).toBe('MEDIUM');
        expect(result.excess).toBe(10);
        expect(pool.query).toHaveBeenCalledTimes(2); // History + Insert
    });

    it('should return HIGH risk and create pending recommendation if excess > 15%', async () => {
        predictDemand.mockResolvedValueOnce({
            predictedQuantity: 100,
            confidenceScore: 0.8,
            keyFactors: {}
        });
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({}); 

        const result = await generatePreventionRecommendation(1, '2026-09-17', 120, 1);
        expect(result.riskLevel).toBe('HIGH');
        expect(result.excess).toBe(20);
        expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it('should handle missing forecast data safely', async () => {
        // Assume forecasting falls back to 0 or throws, let's say it returns 0 predicted
        predictDemand.mockResolvedValueOnce({
            predictedQuantity: 0,
            confidenceScore: 0,
            keyFactors: {}
        });
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await generatePreventionRecommendation(1, '2026-09-17', 50, 1);
        // Excess is 50, but predicted is 0. 50/0 is Infinity, which is > 15%
        expect(result.riskLevel).toBe('HIGH'); 
    });
});

describe('Prevention API Endpoints', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('POST /evaluate should return recommendation for KITCHEN_MANAGER', async () => {
        predictDemand.mockResolvedValueOnce({
            predictedQuantity: 100,
            confidenceScore: 0.8,
            keyFactors: {}
        });
        // 1st query: menuItemModel.findById ownership check, 2nd: history, 3rd: insert
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 1, kitchen_org_id: 1 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({});

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({
                menuItemId: 1,
                targetDate: '2026-09-17',
                plannedQuantity: 110
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.data.riskLevel).toBe('MEDIUM');
    });

    it('POST /evaluate should reject a menu item belonging to another kitchen', async () => {
        // Ownership check finds the menu item, but it belongs to a different org.
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, kitchen_org_id: 999 }] });

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({
                menuItemId: 1,
                targetDate: '2026-09-17',
                plannedQuantity: 110
            });

        expect(res.statusCode).toBe(403);
    });

    it('POST /evaluate should 404 for a nonexistent menu item', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .post('/api/prevention/evaluate')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({
                menuItemId: 999,
                targetDate: '2026-09-17',
                plannedQuantity: 110
            });

        expect(res.statusCode).toBe(404);
    });

    it('PATCH /:id/status should allow manager to approve', async () => {
        pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Mocks the UPDATE

        const res = await request(app)
            .patch('/api/prevention/1/status')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({ status: 'approved' });
        
        expect(res.statusCode).toBe(200);
        expect(res.body.data.status).toBe('approved');
    });

    it('PATCH /:id/status should fail for unauthorized roles', async () => {
        const res = await request(app)
            .patch('/api/prevention/1/status')
            .set('x-mock-role', 'KITCHEN_STAFF') // STAFF cannot approve
            .set('x-mock-org-id', '1')
            .send({ status: 'approved' });
        
        expect(res.statusCode).toBe(403); // Forbidden
    });
});
