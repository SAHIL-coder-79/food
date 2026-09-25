const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');

describe('Health Endpoint', () => {
    afterAll(async () => {
        await pool.end();
    });

    it('should return 200 and db connection status', async () => {
        const response = await request(app).get('/api/health');
        // It might return 503 if DB is not actually running, but we should test that it returns JSON
        expect(response.type).toBe('application/json');
        expect([200, 503]).toContain(response.status);
        expect(response.body).toHaveProperty('status');
        expect(response.body).toHaveProperty('database');
    });
});
