const pool = require('../src/models/db');
const { analyzeWasteRootCause } = require('../src/ai/rootCause');

jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));

describe('Root Cause Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return no_waste if leftover is 0', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 100, quantity_prepared: 100,
                quantity_leftover: 0, headcount: 50, quantity_consumed: 100
            }]
        });

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('no_waste');
        expect(result.estimatedContribution).toBe(0);
    });

    it('should detect over_preparation_vs_plan', async () => {
        pool.query.mockResolvedValueOnce({ // Target Log
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 100, quantity_prepared: 130, // 30% over planned
                quantity_leftover: 30, headcount: 50, quantity_consumed: 100
            }]
        }).mockResolvedValueOnce({ // History
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-14', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-13', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 }
            ]
        }).mockResolvedValueOnce({ // Forecast
            rows: []
        }).mockResolvedValueOnce({}); // Insert

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('over_preparation_vs_plan');
        expect(result.supportingMetrics.overage).toBe(30);
    });

    it('should detect low_attendance', async () => {
        pool.query.mockResolvedValueOnce({ // Target Log
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 100, quantity_prepared: 100,
                quantity_leftover: 40, headcount: 30, quantity_consumed: 60 // 30 headcount vs 50 avg
            }]
        }).mockResolvedValueOnce({ // History
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-14', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-13', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 }
            ]
        }).mockResolvedValueOnce({ // Forecast
            rows: []
        }).mockResolvedValueOnce({}); // Insert

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('low_attendance');
    });

    // Integration bug found by the end-to-end run: a cause could claim more waste than existed (contribution 175 for a
    // log with only 120 left over). A cause can never explain more than the leftover itself.
    it('never attributes more waste to low_attendance than was actually left over', async () => {
        pool.query.mockResolvedValueOnce({ // Target Log: 230 prepared for a planned 150, only 60 people, 120 left over
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 150, quantity_prepared: 230,
                quantity_leftover: 120, headcount: 60, quantity_consumed: 110
            }]
        }).mockResolvedValueOnce({ // History: ~116 people eating ~0.9 each
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 130, headcount: 116, quantity_leftover: 25, quantity_consumed: 105 },
                { log_date: '2026-09-14', quantity_prepared: 130, headcount: 116, quantity_leftover: 25, quantity_consumed: 105 },
                { log_date: '2026-09-13', quantity_prepared: 130, headcount: 116, quantity_leftover: 25, quantity_consumed: 105 }
            ]
        }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('low_attendance');
        expect(result.estimatedContribution).toBe(120); // 230 - 60 x 0.905 = 176 would exceed the 120 left over
    });

    it('never attributes more waste to low_consumption_rate than was actually left over', async () => {
        pool.query.mockResolvedValueOnce({ // 100 people expected to eat 2 each (200), only 50 eaten, but just 50 left over
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 100, quantity_prepared: 100,
                quantity_leftover: 50, headcount: 100, quantity_consumed: 50
            }]
        }).mockResolvedValueOnce({
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 200, headcount: 100, quantity_leftover: 0 },
                { log_date: '2026-09-14', quantity_prepared: 200, headcount: 100, quantity_leftover: 0 },
                { log_date: '2026-09-13', quantity_prepared: 200, headcount: 100, quantity_leftover: 0 }
            ]
        }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('low_consumption_rate');
        expect(result.estimatedContribution).toBe(50); // expected 200 - consumed 50 = 150 would exceed the 50 left over
    });

    it('should detect low_consumption_rate', async () => {
        pool.query.mockResolvedValueOnce({ // Target Log
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 100, quantity_prepared: 100,
                quantity_leftover: 50, headcount: 50, quantity_consumed: 50 // only 1 per person vs 2 avg
            }]
        }).mockResolvedValueOnce({ // History
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-14', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-13', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 }
            ]
        }).mockResolvedValueOnce({ // Forecast
            rows: []
        }).mockResolvedValueOnce({}); // Insert

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('low_consumption_rate');
    });
    
    it('should detect forecast_overestimation', async () => {
        pool.query.mockResolvedValueOnce({ // Target Log
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 150, quantity_prepared: 150,
                quantity_leftover: 50, headcount: 50, quantity_consumed: 100
            }]
        }).mockResolvedValueOnce({ // History
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-14', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-13', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 }
            ]
        }).mockResolvedValueOnce({ // Forecast
            rows: [{ predicted_quantity: 160 }] // forecast was 160, but consumed was only 100
        }).mockResolvedValueOnce({}); // Insert

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('forecast_overestimation');
    });

    it('should return insufficient_data if < 3 historical logs', async () => {
        pool.query.mockResolvedValueOnce({ // Target Log
            rows: [{
                id: 1, menu_item_id: 10, log_date: '2026-09-16',
                quantity_planned: 100, quantity_prepared: 100,
                quantity_leftover: 20, headcount: 50, quantity_consumed: 80
            }]
        }).mockResolvedValueOnce({ // History (only 2 records)
            rows: [
                { log_date: '2026-09-15', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 },
                { log_date: '2026-09-14', quantity_prepared: 100, headcount: 50, quantity_leftover: 0 }
            ]
        });

        const result = await analyzeWasteRootCause(1);
        expect(result.cause).toBe('insufficient_data');
    });
});

// API-level auth/RBAC/ownership coverage for GET /api/root-causes/:dailyLogId lives
// in rootCauseApi.test.js, which exercises the real authenticate/authorize
// middleware and a real database instead of mocking pool.query.
