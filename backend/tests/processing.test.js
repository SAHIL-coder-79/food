const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');

jest.mock('../src/models/db', () => ({
    query: jest.fn(),
    end: jest.fn()
}));

jest.mock('../src/middleware/authenticate', () => {
    return (req, res, next) => {
        req.user = {
            id: 1,
            name: 'Processing User',
            email: 'proc@example.com',
            role: req.headers['x-mock-role'] || 'KITCHEN_MANAGER', // Processing roles map to KITCHEN_MANAGER for simplicity
            organizationId: req.headers['x-mock-org-id'] ? parseInt(req.headers['x-mock-org-id'], 10) : 2 // org type processing
        };
        next();
    };
});

describe('Processing API Endpoints', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('POST /api/processing/products should create a new raw material', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 1, name: 'Apples', unit: 'kg', item_type: 'raw_material', cost_per_unit: 2, preparation_cost_per_unit: 0 }]
        });

        const res = await request(app)
            .post('/api/processing/products')
            .send({ name: 'Apples', unit: 'kg', item_type: 'raw_material', cost_per_unit: 2 });
        
        expect(res.statusCode).toBe(201);
        expect(res.body.data.item_type).toBe('raw_material');
        expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('POST /api/processing/batches should log a production batch via abstraction', async () => {
        // 1st query: ownership check (product belongs to this kitchen), 2nd: the insert
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 1 }] })
            .mockResolvedValueOnce({
                rows: [{
                    id: 1, menu_item_id: 1, log_date: '2026-09-17', meal_slot: 'BATCH',
                    quantity_prepared: 100, quantity_leftover: 5, output_quantity: 95, batch_number: 'B-001'
                }]
            });

        const res = await request(app)
            .post('/api/processing/batches')
            .send({
                product_id: 1,
                log_date: '2026-09-17',
                input_quantity: 100,
                output_quantity: 95,
                rejects_quantity: 5,
                batch_number: 'B-001'
            });

        expect(res.statusCode).toBe(201);
        expect(res.body.data.quantity_prepared).toBe(100); // Abstracted input
        expect(res.body.data.quantity_leftover).toBe(5); // Abstracted rejects
        expect(res.body.data.output_quantity).toBe(95);

        const insertQueryArgs = pool.query.mock.calls[1][1];
        // Expecting [product_id, log_date, mealSlot, input_quantity, rejects_quantity, output_quantity, batch_number, userId]
        expect(insertQueryArgs).toEqual([1, '2026-09-17', 'BATCH', 100, 5, 95, 'B-001', 1]);
    });

    it('POST /api/processing/batches should 404 when the product belongs to another kitchen', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // ownership check finds nothing

        const res = await request(app)
            .post('/api/processing/batches')
            .send({ product_id: 99, log_date: '2026-09-17', input_quantity: 100 });

        expect(res.statusCode).toBe(404);
        expect(pool.query).toHaveBeenCalledTimes(1); // insert never attempted
    });
});
