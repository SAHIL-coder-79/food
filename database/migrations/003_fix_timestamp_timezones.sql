-- Migration 003: fix naive TIMESTAMP columns causing timezone bugs.
--
-- The Postgres server session runs in Asia/Calcutta (UTC+5:30), but the app
-- compares these columns against JS Date.toISOString() (UTC) values and
-- CURRENT_TIMESTAMP (local session time). Naive `timestamp without time zone`
-- columns silently drop the incoming offset, so a listing's safe_until_time
-- could appear already expired. Switching to `timestamptz` stores an
-- unambiguous instant and makes comparisons correct regardless of session
-- timezone. AI tables (ai_*) are intentionally left untouched.

ALTER TABLE organizations
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE users
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE daily_logs
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE surplus_listings
    ALTER COLUMN prepared_time TYPE TIMESTAMPTZ USING prepared_time AT TIME ZONE 'UTC',
    ALTER COLUMN safe_until_time TYPE TIMESTAMPTZ USING safe_until_time AT TIME ZONE 'UTC',
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
    ALTER COLUMN claimed_at TYPE TIMESTAMPTZ USING claimed_at AT TIME ZONE 'UTC',
    ALTER COLUMN proposed_pickup_time TYPE TIMESTAMPTZ USING proposed_pickup_time AT TIME ZONE 'UTC',
    ALTER COLUMN confirmed_pickup_time TYPE TIMESTAMPTZ USING confirmed_pickup_time AT TIME ZONE 'UTC',
    ALTER COLUMN collected_at TYPE TIMESTAMPTZ USING collected_at AT TIME ZONE 'UTC';

ALTER TABLE transactions_log
    ALTER COLUMN collected_at TYPE TIMESTAMPTZ USING collected_at AT TIME ZONE 'UTC',
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE notifications
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
