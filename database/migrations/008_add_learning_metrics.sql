ALTER TABLE ai_interventions 
    ADD COLUMN IF NOT EXISTS recommendation_id INT REFERENCES ai_prevention_recommendations(id),
    ADD COLUMN IF NOT EXISTS expected_result JSONB,
    ADD COLUMN IF NOT EXISTS actual_outcome JSONB,
    ADD COLUMN IF NOT EXISTS effectiveness_score FLOAT,
    ADD COLUMN IF NOT EXISTS manager_action VARCHAR(50);
