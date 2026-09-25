ALTER TABLE ai_waste_root_causes 
    ADD COLUMN IF NOT EXISTS supporting_metrics JSONB,
    ADD COLUMN IF NOT EXISTS estimated_contribution FLOAT;
