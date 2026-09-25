const pool = require('../src/models/db');
const { predictDemand } = require('../src/ai/forecasting');

// Mock the db pool
jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));

describe('Forecasting Service', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    it('should fallback to heuristic if < 3 data points', async () => {
        // Mock returning 2 data points (query 1: logs, query 2: organization events)
        pool.query.mockResolvedValueOnce({
            rows: [
                { log_date: '2026-09-10', quantity_prepared: 100, consumed: 90 },
                { log_date: '2026-09-11', quantity_prepared: 110, consumed: 100 }
            ]
        }).mockResolvedValueOnce({ rows: [] });

        const result = await predictDemand(1, '2026-09-15');

        expect(result.modelVersion).toBe('heuristic_fallback_v1');
        expect(result.predictedQuantity).toBe(105); // (100+110)/2
        expect(result.confidenceScore).toBe(0.3);
        expect(result.keyFactors.reason).toBe('Insufficient historical data');
    });

    it('should use the context-aware statistical model if >= 3 data points', async () => {
        // Mock returning 6 data points
        const mockLogs = [
            { log_date: '2026-09-15', quantity_prepared: 100, consumed: 100 },
            { log_date: '2026-09-14', quantity_prepared: 100, consumed: 100 },
            { log_date: '2026-09-13', quantity_prepared: 100, consumed: 100 },
            { log_date: '2026-09-12', quantity_prepared: 100, consumed: 100 },
            { log_date: '2026-09-11', quantity_prepared: 100, consumed: 100 },
            { log_date: '2026-09-10', quantity_prepared: 100, consumed: 100 }
        ];

        // logs, events, INSERT
        pool.query.mockResolvedValueOnce({ rows: mockLogs }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await predictDemand(1, '2026-09-16'); // Wednesday

        expect(result.modelVersion).toBe('stat_context_v2');
        // Average consumed is 100. Trend is 1.0. With 5% safety buffer it should be 105.
        expect(result.predictedQuantity).toBe(105);
        expect(result.keyFactors.recent_avg).toBe(100);
        expect(result.keyFactors.trend_multiplier).toBe(1);
    });

    it('only reads history strictly before the target date (leakage guard in SQL)', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        await predictDemand(7, '2026-09-16');

        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/log_date < \$2::date/);
        expect(sql).toMatch(/menu_item_id = \$1/);
        expect(params[0]).toBe(7);
        expect(params[1]).toBe('2026-09-16');
    });

    it('reads events only for the menu item\'s own organization and never after the target date', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        await predictDemand(7, '2026-09-16');

        const [sql, params] = pool.query.mock.calls[1];
        expect(sql).toMatch(/FROM organization_events/);
        expect(sql).toMatch(/JOIN menu_items mi ON mi\.kitchen_org_id = e\.organization_id/); // organization comes from the item
        expect(sql).toMatch(/mi\.id = \$1/);
        expect(sql).toMatch(/e\.event_date <= \$2::date/);
        expect(params.slice(0, 2)).toEqual([7, '2026-09-16']);
    });

    it('passes the fetched events to the engine (a closure on the target date zeroes the forecast)', async () => {
        const history = Array.from({ length: 8 }, (_, i) => ({ log_date: `2026-09-0${i + 1}`, quantity_prepared: 100, consumed: 100 }));
        const closure = [{ event_date: '2026-09-16', event_type: 'closure', name: 'Campus closed', expected_impact_pct: -100, created_at: new Date('2026-09-01T00:00:00Z') }];
        pool.query.mockResolvedValueOnce({ rows: history }).mockResolvedValueOnce({ rows: closure }).mockResolvedValueOnce({});

        const result = await predictDemand(1, '2026-09-16');
        expect(result.predictedQuantity).toBe(0);
        expect(result.keyFactors.event_context.target_events[0]).toMatchObject({ type: 'closure', name: 'Campus closed' });
    });

    it('ignores rows dated on/after the target even if the database returned them', async () => {
        const history = Array.from({ length: 8 }, (_, i) => ({
            log_date: `2026-09-0${i + 1}`, quantity_prepared: 100, consumed: 100,
        }));
        const future = [{ log_date: '2026-09-16', quantity_prepared: 9999, consumed: 9999 }, { log_date: '2026-09-17', quantity_prepared: 9999, consumed: 9999 }];
        pool.query.mockResolvedValueOnce({ rows: [...future, ...history] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await predictDemand(1, '2026-09-16');
        expect(result.predictedQuantity).toBe(105);
        expect(result.keyFactors.leakage_guard.future_rows_excluded).toBe(2);
    });

    it('stores the forecast (query 3) with the normalised target date and model version', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});

        const result = await predictDemand(3, '2026-09-16T08:00:00Z');

        expect(pool.query).toHaveBeenCalledTimes(3); // logs, events, INSERT
        const [insertSql, insertParams] = pool.query.mock.calls[2];
        expect(insertSql).toMatch(/INSERT INTO ai_forecasts/);
        expect(insertParams).toEqual([3, '2026-09-16', result.predictedQuantity, result.confidenceScore, result.modelVersion, result.keyFactors]);
    });

    it('does not store anything when run as a simulation', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

        await predictDemand(3, '2026-09-16', true);

        expect(pool.query).toHaveBeenCalledTimes(2); // logs + events only; nothing is stored
    });

    it('still returns the prediction if storing it fails', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('db down'));

        const result = await predictDemand(3, '2026-09-16');
        expect(result.modelVersion).toBe('heuristic_fallback_v1');
        errorSpy.mockRestore();
    });

    it('passes an optional expected headcount through to the engine', async () => {
        const rows = Array.from({ length: 12 }, (_, i) => ({
            log_date: `2026-09-${String(i + 1).padStart(2, '0')}`,
            quantity_consumed: 90 + (i % 3) * 30,
            consumed: 90 + (i % 3) * 30,
            headcount: 100 + (i % 3) * 33,
        }));
        pool.query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] });

        const result = await predictDemand(1, '2026-09-20', true, { expectedHeadcount: 120 });
        expect(result.keyFactors.signals.attendance.expected_headcount_source).toBe('provided');
    });

    it('rejects an invalid target date before touching the database', async () => {
        await expect(predictDemand(1, 'not-a-date')).rejects.toThrow(/Invalid targetDate/);
        await expect(predictDemand(1, '2026-02-30')).rejects.toThrow(/Invalid targetDate/);
        expect(pool.query).not.toHaveBeenCalled();
    });
});

// API-level auth/RBAC/ownership coverage for GET /api/forecasts/:menuItemId lives
// in forecastApi.test.js, which exercises the real authenticate/authorize
// middleware and a real database instead of mocking pool.query. Pure algorithm
// tests (fallback, weekday, trend, attendance, leakage, determinism, confidence,
// backtest vs the previous algorithm) live in forecastEngine.test.js.
