-- processingController.logBatch() records processing-unit production batches into
-- daily_logs with meal_slot = 'BATCH' (see FR for the Processing/Food-Preparation
-- phase). The original meal_slot check only allowed the four kitchen meal slots,
-- so every processing batch insert violated the constraint and failed. Widen it.
ALTER TABLE daily_logs DROP CONSTRAINT daily_logs_meal_slot_check;
ALTER TABLE daily_logs ADD CONSTRAINT daily_logs_meal_slot_check
    CHECK (meal_slot IN ('BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER', 'BATCH'));
