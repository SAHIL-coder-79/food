ALTER TABLE menu_items 
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'prepared_food';

ALTER TABLE daily_logs 
    ADD COLUMN IF NOT EXISTS output_quantity FLOAT,
    ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);

-- No constraint changes are strictly necessary, but we update the logic in the application layer.
