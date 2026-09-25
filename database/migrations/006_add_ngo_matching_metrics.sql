-- Migration 006: Smart NGO Matching metrics.
-- Adds only the columns needed for ranked matching that don't already exist.
-- capacity_kg / preferred_food_types let an NGO describe what/how much it can take.
-- ai_ngo_match_scores already exists (001) with surplus_listing_id/ngo_org_id/
-- match_score/distance_km; add the explainability columns (level/reason/breakdown).

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS capacity_kg FLOAT,
    ADD COLUMN IF NOT EXISTS preferred_food_types TEXT[];

ALTER TABLE ai_ngo_match_scores
    ADD COLUMN IF NOT EXISTS match_level VARCHAR(50),
    ADD COLUMN IF NOT EXISTS reasoning TEXT,
    ADD COLUMN IF NOT EXISTS supporting_metrics JSONB;
