-- Migration 014: secure WhatsApp identity linking (Task 21).
--
-- TASK 20's POST /api/messaging/identities let an authenticated user directly claim any external contact id -
-- fine for the mock provider (a test id has no real owner to impersonate), but not safe for a real phone
-- number: anyone could type someone else's WhatsApp number and claim it. This table implements the "prove
-- control of the WhatsApp account through the WhatsApp conversation" flow instead: an authenticated FoodShare
-- user generates a short-lived, single-use code, then must send that exact code FROM the WhatsApp number
-- being linked before the identity is created. See services/messagingIdentityService.js.

CREATE TABLE messaging_link_requests (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    user_id INT NOT NULL REFERENCES users(id),
    organization_id INT NOT NULL REFERENCES organizations(id),
    provider VARCHAR(50) NOT NULL,
    channel VARCHAR(50) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    -- NULL until the matching WhatsApp message arrives; consumed exactly once (see the atomic
    -- UPDATE ... WHERE consumed_at IS NULL in messagingLinkRequestModel.consumeIfValid), so two near-
    -- simultaneous attempts to redeem the same code can never both succeed.
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messaging_link_requests_code ON messaging_link_requests (code);
