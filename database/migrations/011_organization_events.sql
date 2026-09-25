-- Migration 011: organization-specific calendar events (holidays, festivals, exams, closures, ...).
-- Optional context for demand forecasting. Every event belongs to exactly one organization and no
-- events are seeded: each organization records its own calendar, so no institution's holidays are
-- hardcoded anywhere.
--
-- expected_impact_pct is an optional planning hint: the expected change in demand versus a normal day
-- (+30 = 30% more, -50 = half, -100 = no demand, e.g. a closure). Zero means "noted, no effect".

CREATE TABLE organization_events (
    id SERIAL PRIMARY KEY,
    organization_id INT NOT NULL REFERENCES organizations(id),
    event_date DATE NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    expected_impact_pct DOUBLE PRECISION,
    created_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT organization_events_type_check CHECK (
        event_type IN ('holiday', 'festival', 'exam', 'institutional_event', 'special_meal', 'closure')
    ),
    CONSTRAINT organization_events_impact_check CHECK (
        expected_impact_pct IS NULL OR (expected_impact_pct >= -100 AND expected_impact_pct <= 500)
    ),
    CONSTRAINT organization_events_unique UNIQUE (organization_id, event_date, event_type, name)
);

CREATE INDEX idx_organization_events_org_date ON organization_events (organization_id, event_date);
