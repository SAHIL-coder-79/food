ALTER TABLE ai_rescue_priorities
    ADD COLUMN IF NOT EXISTS priority_level VARCHAR(50),
    ADD COLUMN IF NOT EXISTS urgency_score FLOAT,
    ADD COLUMN IF NOT EXISTS impact_score FLOAT,
    ADD COLUMN IF NOT EXISTS supporting_metrics JSONB;
