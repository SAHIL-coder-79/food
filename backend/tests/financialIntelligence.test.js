const pool = require('../src/models/db');
const { calculateFinancialImpact } = require('../src/ai/financialIntelligence');

// Mock external dependencies
jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));

describe('Financial Intelligence Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should correctly calculate loss from daily logs', async () => {
        // Mock query returning some logs with costs
        pool.query.mockResolvedValueOnce({
            rows: [
                { log_date: '2026-09-16', menu_item_name: 'Rice', quantity_leftover: 10, cost_per_unit: 2, preparation_cost_per_unit: 1 },
                { log_date: '2026-09-16', menu_item_name: 'Curry', quantity_leftover: 5, cost_per_unit: 4, preparation_cost_per_unit: 2 },
                { log_date: '2026-09-15', menu_item_name: 'Rice', quantity_leftover: 20, cost_per_unit: 2, preparation_cost_per_unit: 1 }
            ]
        }).mockResolvedValueOnce({ rows: [{ collected_quantity: 8, listings_collected: '2' }] }) // rescued (collected) surplus
            .mockResolvedValueOnce({}); // INSERT summary query

        const result = await calculateFinancialImpact(1, 'weekly');
        
        // Rice loss: 10 * 3 + 20 * 3 = 30 + 60 = 90
        // Curry loss: 5 * 6 = 30
        // Total loss: 120
        expect(result.totalEstimatedLoss).toBe(120);
        expect(result.breakdown.lossByItem['Rice']).toBe(90);
        expect(result.breakdown.lossByItem['Curry']).toBe(30);
        
        // By date
        expect(result.breakdown.lossByDate['2026-09-16']).toBe(60); // 30 (Rice) + 30 (Curry)
        expect(result.breakdown.lossByDate['2026-09-15']).toBe(60); // 60 (Rice)

        expect(result.breakdown.potentialSavings).toBe(120);
        expect(result.isEstimate).toBe(true);

        // Environmental impact: total leftover 10 + 5 + 20 = 35 units.
        // 35 * 2.5 kg CO2e/unit = 87.5; floor(35 / 0.4 kg per meal) = 87 meals.
        expect(result.environmentalImpact.estimatedCo2eKg).toBe(87.5);
        expect(result.environmentalImpact.mealEquivalents).toBe(87);
        expect(result.environmentalImpact.isEstimate).toBe(true);

        // Surplus that was actually collected by NGOs is reported separately and leaves the loss figures untouched:
        // 8 units -> 20 kg CO2e, floor(8 / 0.4) = 20 meals.
        expect(result.rescued).toMatchObject({ listingsCollected: 2, collectedQuantity: 8, mealEquivalents: 20, co2eAvoidedKg: 20, isEstimate: true });
        expect(result.rescued.note).toMatch(/still included in the loss/);
        expect(pool.query.mock.calls[1][0]).toMatch(/FROM transactions_log/);
        expect(pool.query.mock.calls[1][0]).toContain("sl.kitchen_org_id = $1");
        expect(pool.query.mock.calls[1][1]).toEqual([1]);
    });

    it('should handle zero costs gracefully', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [
                { log_date: '2026-09-16', menu_item_name: 'Rice', quantity_leftover: 10, cost_per_unit: 0, preparation_cost_per_unit: 0 }
            ]
        }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await calculateFinancialImpact(1, 'daily');
        expect(result.totalEstimatedLoss).toBe(0);
        expect(result.breakdown.lossByItem['Rice']).toBe(0);
        // Financial loss is zero (no cost configured), but the environmental
        // estimate is still based on wasted quantity, independent of cost.
        expect(result.environmentalImpact.estimatedCo2eKg).toBe(25);
        expect(result.environmentalImpact.mealEquivalents).toBe(25);
    });

    it('should report zero environmental impact when there is no waste', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ collected_quantity: '0', listings_collected: '0' }] });

        const result = await calculateFinancialImpact(1, 'daily');
        expect(result.environmentalImpact.estimatedCo2eKg).toBe(0);
        expect(result.environmentalImpact.mealEquivalents).toBe(0);
        expect(result.rescued).toMatchObject({ listingsCollected: 0, collectedQuantity: 0, mealEquivalents: 0, co2eAvoidedKg: 0 });
    });
});

// API-level auth/RBAC/behavior coverage for GET /api/financial-impact lives in
// financialImpactApi.test.js, which exercises the real authenticate/authorize
// middleware and a real database instead of mocking pool.query.
