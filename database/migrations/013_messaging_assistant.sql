-- Migration 013: WhatsApp-ready Conversational Assistant (Task 20).
--
-- Provider-agnostic messaging identity mapping and short-lived conversation state. This sits ON TOP of the
-- existing surplus/rescue/notification business logic - it never duplicates it. See
-- backend/src/integrations/messaging/, backend/src/ai/conversationalAssistant/ and
-- backend/src/services/messagingAssistantService.js.

-- Maps one external messaging contact (a WhatsApp number, in the mock provider's case an arbitrary test id)
-- to exactly one existing FoodShare user/organization. Created only through an authenticated FoodShare
-- session (see routes/messagingRoutes.js POST /identities) - never automatically from an inbound message,
-- so a message can never claim to be "from" an organization it wasn't already linked to.
CREATE TABLE messaging_identities (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    channel VARCHAR(50) NOT NULL,
    external_user_id VARCHAR(255) NOT NULL,
    user_id INT NOT NULL REFERENCES users(id),
    organization_id INT NOT NULL REFERENCES organizations(id),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT messaging_identities_unique_contact UNIQUE (provider, channel, external_user_id)
);

CREATE INDEX idx_messaging_identities_user ON messaging_identities (user_id);

-- Short-lived, single-active-session-per-identity conversation state (e.g. "awaiting confirmation of a
-- pending surplus report"). Never a full chat transcript/history - only the one pending thing, with an
-- expiry, replaced (never accumulated) on every new turn.
CREATE TABLE conversation_sessions (
    id SERIAL PRIMARY KEY,
    messaging_identity_id INT NOT NULL UNIQUE REFERENCES messaging_identities(id),
    intent VARCHAR(50) NOT NULL,
    state VARCHAR(50) NOT NULL,
    pending_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency: a messaging provider's webhook can and does redeliver the same message. The same
-- (provider, channel, externalMessageId) must never be processed twice - enforced here, not just in
-- application code, so a race between two near-simultaneous deliveries can't slip through.
CREATE TABLE messaging_inbound_log (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    channel VARCHAR(50) NOT NULL,
    external_message_id VARCHAR(255) NOT NULL,
    messaging_identity_id INT REFERENCES messaging_identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT messaging_inbound_log_unique_message UNIQUE (provider, channel, external_message_id)
);
