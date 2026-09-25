const bcrypt = require('bcrypt');
const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/models/db');
const userModel = require('../src/models/userModel');
const { ROLES } = require('../src/utils/constants');

const OPERATIONAL_TABLES = [
    'notifications',
    'transactions_log',
    'surplus_listings',
    'daily_logs',
    'menu_items',
    'users',
    'organizations',
];

async function resetDb() {
    await pool.query(`TRUNCATE TABLE ${OPERATIONAL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

let emailCounter = 0;
function uniqueEmail(prefix) {
    emailCounter += 1;
    return `${prefix}${Date.now()}${emailCounter}@example.com`;
}

// Local calendar date (not UTC), matching how the server defines "today"
// for the daily-log day-end lock (see src/services/dailyLogService.js).
function localDateString(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function registerKitchen(overrides = {}) {
    const email = overrides.email || uniqueEmail('kitchen');
    const res = await request(app)
        .post('/api/auth/register-organization')
        .send({
            organizationName: overrides.organizationName || 'Test Kitchen',
            organizationType: 'kitchen',
            pincode: '123456',
            name: overrides.name || 'Kitchen Manager',
            email,
            password: overrides.password || 'password123',
            ...overrides.extra,
        });
    return res.body;
}

async function registerNgo(overrides = {}) {
    const email = overrides.email || uniqueEmail('ngo');
    const res = await request(app)
        .post('/api/auth/register-organization')
        .send({
            organizationName: overrides.organizationName || 'Test NGO',
            organizationType: 'ngo',
            pincode: '654321',
            name: overrides.name || 'NGO Admin',
            email,
            password: overrides.password || 'password123',
            ...overrides.extra,
        });
    return res.body;
}

async function createSystemAdmin() {
    const email = uniqueEmail('sysadmin');
    const passwordHash = await bcrypt.hash('password123', 4);
    const user = await userModel.create({
        name: 'System Admin',
        email,
        passwordHash,
        role: ROLES.SYSTEM_ADMIN,
        organizationId: null,
    });

    const loginRes = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    return { user, token: loginRes.body.token };
}

async function verifyNgo(ngoOrgId, systemAdminToken) {
    return request(app)
        .patch(`/api/organizations/${ngoOrgId}/verify`)
        .set('Authorization', `Bearer ${systemAdminToken}`)
        .send({ verificationStatus: 'verified' });
}

module.exports = {
    app,
    pool,
    resetDb,
    uniqueEmail,
    localDateString,
    registerKitchen,
    registerNgo,
    createSystemAdmin,
    verifyNgo,
};
