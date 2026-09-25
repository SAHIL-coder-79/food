const fs = require('fs');
const path = require('path');
const pool = require('../src/models/db');

const MIGRATIONS_DIR = path.join(__dirname, '../../database/migrations');

async function ensureMigrationsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function getAppliedMigrations() {
    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    return new Set(rows.map((row) => row.filename));
}

async function runMigrations() {
    try {
        await ensureMigrationsTable();
        const applied = await getAppliedMigrations();

        const files = fs
            .readdirSync(MIGRATIONS_DIR)
            .filter((file) => file.endsWith('.sql'))
            .sort();

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`Skipping already-applied migration: ${file}`);
                continue;
            }

            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            console.log(`Running migration: ${file}`);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log(`Applied: ${file}`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        }

        console.log('All migrations complete.');
    } catch (error) {
        console.error('Migration failed:', error);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

runMigrations();
