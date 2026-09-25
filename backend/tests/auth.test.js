const request = require('supertest');
const { app, pool, resetDb, uniqueEmail, registerKitchen, registerNgo } = require('./testHelpers');

describe('Authentication', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('registers a new kitchen organization with a KITCHEN_MANAGER admin user', async () => {
        const res = await registerKitchen();
        expect(res).toHaveProperty('token');
        expect(res.user.role).toBe('KITCHEN_MANAGER');
        expect(res.organization.type).toBe('kitchen');
        expect(res.organization.verification_status).toBe('verified');
        expect(res.user).not.toHaveProperty('password_hash');
    });

    it('registers a new NGO organization as pending verification with an NGO_ADMIN', async () => {
        const res = await registerNgo();
        expect(res.user.role).toBe('NGO_ADMIN');
        expect(res.organization.type).toBe('ngo');
        expect(res.organization.verification_status).toBe('pending');
    });

    it('rejects registration with an already-used email', async () => {
        const email = uniqueEmail('dup');
        await registerKitchen({ email });
        const res = await registerKitchen({ email });
        expect(res).not.toHaveProperty('token');
    });

    it('rejects registration with a short password', async () => {
        const res = await request(app)
            .post('/api/auth/register-organization')
            .send({
                organizationName: 'Weak Pw Kitchen',
                organizationType: 'kitchen',
                name: 'Manager',
                email: uniqueEmail('weak'),
                password: '123',
            });
        expect(res.status).toBe(400);
    });

    it('logs in with correct credentials and returns a JWT', async () => {
        const email = uniqueEmail('login');
        await registerKitchen({ email, password: 'password123' });

        const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
    });

    it('rejects login with an incorrect password with a generic error', async () => {
        const email = uniqueEmail('badpw');
        await registerKitchen({ email, password: 'password123' });

        const res = await request(app).post('/api/auth/login').send({ email, password: 'wrongpassword' });
        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/invalid email or password/i);
    });

    it('never returns the password hash from login', async () => {
        const email = uniqueEmail('nohash');
        await registerKitchen({ email, password: 'password123' });
        const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
        expect(res.body.user).not.toHaveProperty('password_hash');
    });

    it('rejects requests without a token on a protected route', async () => {
        const res = await request(app).get('/api/auth/me');
        expect(res.status).toBe(401);
    });

    it('rejects requests with a malformed/invalid token', async () => {
        const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-real-token');
        expect(res.status).toBe(401);
    });

    it('returns the current user profile for a valid token', async () => {
        const { token, user } = await registerKitchen();
        const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.user.id).toBe(user.id);
        expect(res.body.organization.type).toBe('kitchen');
    });

    it('lets a KITCHEN_MANAGER create a KITCHEN_STAFF user scoped to their own org (ignoring any client-supplied organizationId)', async () => {
        const kitchen = await registerKitchen();
        const otherKitchen = await registerKitchen();

        const res = await request(app)
            .post('/api/auth/users')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                name: 'Staff Member',
                email: uniqueEmail('staff'),
                password: 'password123',
                role: 'KITCHEN_STAFF',
                organizationId: otherKitchen.organization.id, // attempted spoof — must be ignored
            });

        expect(res.status).toBe(201);
        expect(res.body.user.organization_id).toBe(kitchen.organization.id);
        expect(res.body.user.organization_id).not.toBe(otherKitchen.organization.id);
    });

    it('prevents a KITCHEN_MANAGER from assigning an NGO role', async () => {
        const kitchen = await registerKitchen();
        const res = await request(app)
            .post('/api/auth/users')
            .set('Authorization', `Bearer ${kitchen.token}`)
            .send({
                name: 'Sneaky',
                email: uniqueEmail('sneaky'),
                password: 'password123',
                role: 'NGO_ADMIN',
            });
        expect(res.status).toBe(403);
    });
});
