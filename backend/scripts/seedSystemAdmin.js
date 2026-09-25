// Bootstraps the first SYSTEM_ADMIN account. Credentials are read from
// environment variables — never hardcoded — so this script is safe to keep
// in source control and re-run (it is a no-op if the admin already exists).
//
// Usage: set SYSTEM_ADMIN_EMAIL and SYSTEM_ADMIN_PASSWORD in .env, then run
//   node scripts/seedSystemAdmin.js

const bcrypt = require('bcrypt');
const env = require('../src/config/env');
const pool = require('../src/models/db');
const userModel = require('../src/models/userModel');
const { ROLES } = require('../src/utils/constants');

async function seed() {
    const email = process.env.SYSTEM_ADMIN_EMAIL;
    const password = process.env.SYSTEM_ADMIN_PASSWORD;
    const name = process.env.SYSTEM_ADMIN_NAME || 'System Administrator';

    if (!email || !password) {
        console.error('SYSTEM_ADMIN_EMAIL and SYSTEM_ADMIN_PASSWORD must be set in the environment.');
        process.exitCode = 1;
        return;
    }

    try {
        const existing = await userModel.findByEmail(email);
        if (existing) {
            console.log(`System admin already exists for ${email}; nothing to do.`);
            return;
        }

        const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);
        const user = await userModel.create({
            name,
            email,
            passwordHash,
            role: ROLES.SYSTEM_ADMIN,
            organizationId: null,
        });
        console.log(`Created system admin: ${user.email} (id ${user.id})`);
    } catch (error) {
        console.error('Failed to seed system admin:', error);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

seed();
