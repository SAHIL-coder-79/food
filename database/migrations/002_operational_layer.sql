-- Migration 002: Core operational layer (auth, RBAC, daily logs, surplus claim/pickup, notifications)
-- Adds fields/constraints required by the operational layer without touching AI tables
-- (only additive foreign-key-safe changes are made; no ai_* table is altered).

-- --- organizations -----------------------------------------------------
ALTER TABLE organizations
    ADD CONSTRAINT organizations_type_check CHECK (type IN ('kitchen', 'ngo')),
    ADD CONSTRAINT organizations_verification_status_check
        CHECK (verification_status IN ('pending', 'verified', 'rejected'));

-- --- users ---------------------------------------------------------------
ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (
        role IN ('KITCHEN_STAFF', 'KITCHEN_MANAGER', 'NGO_COORDINATOR', 'NGO_ADMIN', 'SYSTEM_ADMIN')
    ),
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);

-- --- menu_items ------------------------------------------------------------
ALTER TABLE menu_items
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_menu_items_kitchen_org_id ON menu_items(kitchen_org_id);

-- --- daily_logs ------------------------------------------------------------
-- PRD calls for planned quantity, prepared quantity, attendance, consumed quantity
-- and leftover/waste quantity. quantity_prepared/headcount/quantity_leftover already
-- exist; add the missing planned/consumed fields.
ALTER TABLE daily_logs
    ADD COLUMN quantity_planned FLOAT,
    ADD COLUMN quantity_consumed FLOAT,
    ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ADD CONSTRAINT daily_logs_meal_slot_check
        CHECK (meal_slot IN ('BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER')),
    ADD CONSTRAINT daily_logs_quantities_nonnegative_check CHECK (
        (quantity_planned IS NULL OR quantity_planned >= 0) AND
        (quantity_prepared IS NULL OR quantity_prepared >= 0) AND
        (quantity_consumed IS NULL OR quantity_consumed >= 0) AND
        (quantity_leftover IS NULL OR quantity_leftover >= 0) AND
        (headcount IS NULL OR headcount >= 0)
    );

CREATE INDEX IF NOT EXISTS idx_daily_logs_menu_item_id ON daily_logs(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_log_date ON daily_logs(log_date);

-- --- surplus_listings --------------------------------------------------
-- Add claim/pickup workflow fields (claimant user, timestamps, proposed/confirmed
-- pickup time, collection actor) needed for FR-13/FR-14/FR-15.
ALTER TABLE surplus_listings
    ADD COLUMN claimed_by_user_id INT REFERENCES users(id),
    ADD COLUMN claimed_at TIMESTAMP,
    ADD COLUMN proposed_pickup_time TIMESTAMP,
    ADD COLUMN confirmed_pickup_time TIMESTAMP,
    ADD COLUMN collected_at TIMESTAMP,
    ADD COLUMN collected_by_user_id INT REFERENCES users(id),
    ADD CONSTRAINT surplus_listings_status_check
        CHECK (status IN ('Available', 'Claimed', 'Collected', 'Expired')),
    ADD CONSTRAINT surplus_listings_quantity_positive_check CHECK (quantity > 0);

CREATE INDEX IF NOT EXISTS idx_surplus_listings_kitchen_org_id ON surplus_listings(kitchen_org_id);
CREATE INDEX IF NOT EXISTS idx_surplus_listings_claimed_by_ngo_id ON surplus_listings(claimed_by_ngo_id);
CREATE INDEX IF NOT EXISTS idx_surplus_listings_status ON surplus_listings(status);

-- --- notifications -------------------------------------------------------
-- Missing from 001_initial_schema.sql despite being in the PRD's data model;
-- add it here (id, user_id, type, message, is_read, created_at).
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    type VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user_id_is_read ON notifications(user_id, is_read);
