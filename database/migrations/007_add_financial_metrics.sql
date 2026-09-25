-- Add configurable costs to menu_items
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS cost_per_unit FLOAT DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS preparation_cost_per_unit FLOAT DEFAULT 0;

-- Expand ai_financial_impacts for tracking details
ALTER TABLE ai_financial_impacts ADD COLUMN IF NOT EXISTS estimated_loss FLOAT DEFAULT 0;
ALTER TABLE ai_financial_impacts ADD COLUMN IF NOT EXISTS breakdown JSONB;
