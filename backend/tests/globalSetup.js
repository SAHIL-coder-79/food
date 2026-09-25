const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = async function globalSetup() {
    const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.warn(
            '[tests/globalSetup] No TEST_DATABASE_URL/DATABASE_URL configured — skipping migrations. ' +
                'DB-backed tests will fail with connection errors.'
        );
        return;
    }

    try {
        execFileSync(process.execPath, [path.join(__dirname, '../scripts/migrate.js')], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
            stdio: 'inherit',
        });
    } catch (error) {
        console.warn('[tests/globalSetup] Migration run failed:', error.message);
    }
};
