ALTER TABLE ai_prevention_recommendations
    ADD COLUMN IF NOT EXISTS menu_item_id INT REFERENCES menu_items(id),
    ADD COLUMN IF NOT EXISTS target_date DATE,
    ADD COLUMN IF NOT EXISTS risk_level VARCHAR(50),
    ADD COLUMN IF NOT EXISTS recommended_quantity FLOAT,
    ADD COLUMN IF NOT EXISTS estimated_excess FLOAT,
    ADD COLUMN IF NOT EXISTS supporting_evidence JSONB;
