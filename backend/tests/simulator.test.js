const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');
const { runSimulation } = require('../src/ai/simulator');
const { predictDemand } = require('../src/ai/forecasting');
const { registerKitchen } = require('./testHelpers');

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

describe('What-If Simulator Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should calculate surplus and waste correctly for over-preparation', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ cost_per_unit: 5, preparation_cost_per_unit: 2 }]
        }).mockResolvedValueOnce({}); // INSERT simulation log

        predictDemand.mockResolvedValueOnce({ predictedQuantity: 100 });

        const result = await runSimulation(1, { menuItemId: 10, targetDate: '2026-09-17', proposedQuantity: 120 });
        
        expect(predictDemand).toHaveBeenCalledWith(10, '2026-09-17', true); // isSimulation = true
        expect(result.predictedDemand).toBe(100);
        expect(result.estimatedSurplus).toBe(20);
        expect(result.estimatedShortageRisk).toBe(0);
        expect(result.financialWaste).toBe(140); // 20 surplus * 7 cost
        expect(result.environmentalImpact.co2eEmissionsKg).toBe(50); // 20 * 2.5
        expect(result.environmentalImpact.mealEquivalents).toBe(50); // 20 / 0.4
    });

    it('should calculate shortage risk correctly for under-preparation', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ cost_per_unit: 5, preparation_cost_per_unit: 2 }]
        }).mockResolvedValueOnce({}); 

        predictDemand.mockResolvedValueOnce({ predictedQuantity: 100 });

        const result = await runSimulation(1, { menuItemId: 10, targetDate: '2026-09-17', proposedQuantity: 80 });
        
        expect(result.predictedDemand).toBe(100);
        expect(result.estimatedSurplus).toBe(0);
        expect(result.estimatedShortageRisk).toBe(20);
        expect(result.financialWaste).toBe(0); 
    });

    it('should throw if menu item missing', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });
        await expect(runSimulation(1, { menuItemId: 99, targetDate: '2026-09-17', proposedQuantity: 100 }))
            .rejects.toThrow('Menu item not found or unauthorized');
    });
});

describe('Simulation API Endpoint', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('POST /api/simulations/run should return metrics for KITCHEN_MANAGER', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ cost_per_unit: 5, preparation_cost_per_unit: 2 }]
        }).mockResolvedValueOnce({});

        predictDemand.mockResolvedValueOnce({ predictedQuantity: 100 });

        const res = await request(app)
            .post('/api/simulations/run')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({ menuItemId: 10, targetDate: '2026-09-17', proposedQuantity: 120 });
        
        expect(res.statusCode).toBe(200);
        expect(res.body.data.estimatedSurplus).toBe(20);
    });

    it('should reject requests with missing parameters', async () => {
        const res = await request(app)
            .post('/api/simulations/run')
            .set('x-mock-role', 'KITCHEN_MANAGER')
            .set('x-mock-org-id', '1')
            .send({ targetDate: '2026-09-17' }); // Missing menuItemId and proposedQuantity
        
        expect(res.statusCode).toBe(400);
    });
});
