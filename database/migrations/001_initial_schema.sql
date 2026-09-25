CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core Tables
CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'kitchen' or 'ngo'
    pincode VARCHAR(20),
    latitude FLOAT,
    longitude FLOAT,
    service_radius_km FLOAT,
    verification_status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    organization_id INT REFERENCES organizations(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    kitchen_org_id INT REFERENCES organizations(id),
    name VARCHAR(255) NOT NULL,
    unit VARCHAR(50) NOT NULL
);

CREATE TABLE daily_logs (
    id SERIAL PRIMARY KEY,
    menu_item_id INT REFERENCES menu_items(id),
    log_date DATE NOT NULL,
    meal_slot VARCHAR(50) NOT NULL,
    quantity_prepared FLOAT,
    headcount INT,
    quantity_leftover FLOAT,
    created_by INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (menu_item_id, log_date, meal_slot)
);

CREATE TABLE surplus_listings (
    id SERIAL PRIMARY KEY,
    daily_log_id INT REFERENCES daily_logs(id),
    kitchen_org_id INT REFERENCES organizations(id),
    claimed_by_ngo_id INT REFERENCES organizations(id),
    quantity FLOAT NOT NULL,
    food_type VARCHAR(100),
    prepared_time TIMESTAMP,
    safe_until_time TIMESTAMP NOT NULL,
    status VARCHAR(50) DEFAULT 'Available',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions_log (
    id SERIAL PRIMARY KEY,
    surplus_listing_id INT REFERENCES surplus_listings(id),
    collected_at TIMESTAMP,
    quantity_collected FLOAT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI / Intelligence Tables (Phase 1 preparation)
CREATE TABLE ai_forecasts (
    id SERIAL PRIMARY KEY,
    menu_item_id INT REFERENCES menu_items(id),
    target_date DATE NOT NULL,
    predicted_quantity FLOAT NOT NULL,
    confidence_score FLOAT,
    model_version VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_waste_root_causes (
    id SERIAL PRIMARY KEY,
    daily_log_id INT REFERENCES daily_logs(id),
    inferred_cause TEXT,
    confidence_score FLOAT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_prevention_recommendations (
    id SERIAL PRIMARY KEY,
    kitchen_org_id INT REFERENCES organizations(id),
    recommendation_text TEXT,
    potential_savings FLOAT,
    status VARCHAR(50) DEFAULT 'new',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_rescue_priorities (
    id SERIAL PRIMARY KEY,
    surplus_listing_id INT REFERENCES surplus_listings(id),
    priority_score FLOAT NOT NULL,
    reasoning TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_ngo_match_scores (
    id SERIAL PRIMARY KEY,
    surplus_listing_id INT REFERENCES surplus_listings(id),
    ngo_org_id INT REFERENCES organizations(id),
    match_score FLOAT NOT NULL,
    distance_km FLOAT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_financial_impacts (
    id SERIAL PRIMARY KEY,
    organization_id INT REFERENCES organizations(id),
    period_start DATE,
    period_end DATE,
    estimated_savings FLOAT,
    estimated_co2e_avoided FLOAT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_simulations (
    id SERIAL PRIMARY KEY,
    kitchen_org_id INT REFERENCES organizations(id),
    scenario_name VARCHAR(255),
    parameters JSONB,
    predicted_outcome JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_interventions (
    id SERIAL PRIMARY KEY,
    kitchen_org_id INT REFERENCES organizations(id),
    intervention_type VARCHAR(100),
    learning_feedback JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_processing_batches (
    id SERIAL PRIMARY KEY,
    batch_type VARCHAR(100),
    status VARCHAR(50) DEFAULT 'processing',
    records_processed INT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);
