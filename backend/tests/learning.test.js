const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');
const { evaluateInterventions } = require('../src/ai/learning');
const { generatePreventionRecommendation } = require('../src/ai/prevention');
const { predictDemand } = require('../src/ai/forecasting');

// Mock external dependencies
jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));

jest.mock('../src/middleware/authenticate', () => {
    return (req, res, next) => {
        req.user = {
            id: 1,
            name: 'Test',
            email: 'test@example.com',
            role: req.headers['x-mock-role'] || 'KITCHEN_MANAGER',
            organizationId: req.headers['x-mock-org-id'] ? parseInt(req.headers['x-mock-org-id'], 10) : 1
        };
        next();
    };
});

jest.mock('../src/ai/forecasting', () => ({
    predictDemand: jest.fn()
}));

describe('Learning Evaluation Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should score an approved recommendation with zero leftover as 1.0', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{
                id: 1, menu_item_id: 10, target_date: '2026-09-17', manager_action: 'approved',
                recommended_quantity: 100, estimated_excess: 20, 
                quantity_prepared: 100, quantity_leftover: 0
            }]
        }).mockResolvedValueOnce({}); // INSERT learning record

        const result = await evaluateInterventions(1, '2026-09-17');
        
        expect(result.length).toBe(1);
        expect(result[0].effectivenessScore).toBe(1.0);
    });

    it('should calculate partial score for approved recommendation with some leftover', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{
                id: 1, menu_item_id: 10, target_date: '2026-09-17', manager_action: 'approved',
                recommended_quantity: 100, estimated_excess: 20, // originally planned 120
                quantity_prepared: 100, quantity_leftover: 5 // Avoided 20, but wasted 5
            }]
        }).mockResolvedValueOnce({}); 

        const result = await evaluateInterventions(1, '2026-09-17');
        
        expect(result.length).toBe(1);
        expect(result[0].effectivenessScore).toBe(0.8); // 20 / (20 + 5)
    });

    it('should score a rejected recommendation that resulted in waste as 1.0 (AI was right)', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{
                id: 1, menu_item_id: 10, target_date: '2026-09-17', manager_action: 'rejected',
                recommended_quantity: 100, estimated_excess: 20, 
                quantity_prepared: 120, quantity_leftover: 15 // AI recommended 100, they rejected, wasted 15
            }]
        }).mockResolvedValueOnce({}); 

        const result = await evaluateInterventions(1, '2026-09-17');
        
        expect(result.length).toBe(1);
        expect(result[0].effectivenessScore).toBe(1.0);
    });

    it('should score a rejected recommendation with zero waste as -1.0 (AI was wrong)', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{
                id: 1, menu_item_id: 10, target_date: '2026-09-17', manager_action: 'rejected',
                recommended_quantity: 100, estimated_excess: 20, 
                quantity_prepared: 120, quantity_leftover: 0 // They rejected and served everything
            }]
        }).mockResolvedValueOnce({}); 

        const result = await evaluateInterventions(1, '2026-09-17');
        
        expect(result.length).toBe(1);
        expect(result[0].effectivenessScore).toBe(-1.0);
    });
});

describe('Learning Hooks in Prevention Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should boost confidence and update text if historical effectiveness is > 0.5', async () => {
        predictDemand.mockResolvedValueOnce({ predictedQuantity: 100, confidenceScore: 0.8, keyFactors: {} });
        
        pool.query.mockResolvedValueOnce({
            rows: [{ avg_score: 0.8, count: 2 }] // history query
        }).mockResolvedValueOnce({}); // INSERT prevention rec

        const result = await generatePreventionRecommendation(10, '2026-09-18', 120, 1);
        
        expect(result.confidence).toBe(0.9); // 0.8 + 0.1
        // Verify insert text contains history note
        const insertQueryArgs = pool.query.mock.calls[1][1];
        expect(insertQueryArgs[3]).toContain('Past reductions were highly effective');
    });

    it('should lower confidence and update text if historical effectiveness is < 0', async () => {
        predictDemand.mockResolvedValueOnce({ predictedQuantity: 100, confidenceScore: 0.8, keyFactors: {} });
        
        pool.query.mockResolvedValueOnce({
            rows: [{ avg_score: -0.5, count: 2 }] // history query
        }).mockResolvedValueOnce({}); // INSERT prevention rec

        const result = await generatePreventionRecommendation(10, '2026-09-18', 120, 1);
        
        expect(result.confidence).toBeCloseTo(0.7); // 0.8 - 0.1
        const insertQueryArgs = pool.query.mock.calls[1][1];
        expect(insertQueryArgs[3]).toContain('Past recommendations were rejected or inaccurate');
    });
});

describe('Learning API Endpoint', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('POST /api/learning/evaluate should trigger learning process', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{
                id: 1, menu_item_id: 10, target_date: '2026-09-17', manager_action: 'approved',
                recommended_quantity: 100, estimated_excess: 20, 
                quantity_prepared: 100, quantity_leftover: 0
            }]
        }).mockResolvedValueOnce({});

        const res = await request(app)
            .post('/api/learning/evaluate')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({ targetDate: '2026-09-17' });
        
        expect(res.statusCode).toBe(200);
        expect(res.body.data[0].effectivenessScore).toBe(1.0);
    });
});
