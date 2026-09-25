-- Migration 012: hash-chained Donation Integrity Ledger (Task 17).
--
-- A lightweight, tamper-evident audit trail over the existing surplus donation lifecycle. It is NOT a
-- blockchain (no distributed consensus, no mining, no tokens) and it does NOT replace surplus_listings as
-- the source of truth for a donation's current state - it is an append-only record of the events that
-- already happen there (create/claim/confirm pickup/collect/expire), each one cryptographically linked to
-- the previous event for the same listing so that editing or reordering a past entry is detectable.
--
-- previous_hash for the first event of a listing is a fixed genesis value (64 zero characters - see
-- backend/src/utils/hashChain.js GENESIS_HASH). Rows are only ever inserted, never updated or deleted, by
-- application code (see services/donationLedgerService.js).

CREATE TABLE donation_ledger_entries (
    id SERIAL PRIMARY KEY,
    surplus_listing_id INT NOT NULL REFERENCES surplus_listings(id),
    sequence_number INT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    organization_id INT NOT NULL REFERENCES organizations(id),
    actor_user_id INT REFERENCES users(id),
    event_timestamp TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    previous_hash CHAR(64) NOT NULL,
    entry_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT donation_ledger_entries_event_type_check CHECK (
        event_type IN ('SURPLUS_CREATED', 'SURPLUS_CLAIMED', 'PICKUP_CONFIRMED', 'SURPLUS_COLLECTED', 'SURPLUS_EXPIRED')
    ),
    -- Every event in this lifecycle happens at most once per listing (no "unclaim" or repeat-collect flow),
    -- so a second attempt at the same event (e.g. confirming pickup twice) must be refused as a duplicate,
    -- not recorded as a new event - see donationLedgerService.recordEvent.
    CONSTRAINT donation_ledger_entries_unique_event UNIQUE (surplus_listing_id, event_type),
    CONSTRAINT donation_ledger_entries_unique_sequence UNIQUE (surplus_listing_id, sequence_number),
    CONSTRAINT donation_ledger_entries_unique_hash UNIQUE (entry_hash)
);

CREATE INDEX idx_donation_ledger_entries_listing ON donation_ledger_entries (surplus_listing_id, sequence_number);
