-- DRISHTI core schema (PostgreSQL + PostGIS)
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS quarries (
    quarry_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    district    TEXT,
    location    GEOGRAPHY(POINT, 4326)
);

CREATE TABLE IF NOT EXISTS blocks (
    id                    BIGSERIAL PRIMARY KEY,
    block_id              TEXT UNIQUE NOT NULL,
    quarry_id             TEXT REFERENCES quarries(quarry_id),
    captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    gps                   GEOGRAPHY(POINT, 4326),
    gps_accuracy_cm       INTEGER,
    length_m              DOUBLE PRECISION,
    width_m               DOUBLE PRECISION,
    height_m              DOUBLE PRECISION,
    volume_m3             DOUBLE PRECISION,
    confidence            DOUBLE PRECISION,
    measurement_method    TEXT,             -- mobile_monocular | robot_stereo_pointcloud
    classification        TEXT,             -- above_gangsaw | below_gangsaw
    granite_category      TEXT,
    seigniorage_fee_inr   DOUBLE PRECISION,
    source                TEXT NOT NULL,    -- mobile | robot
    status                TEXT NOT NULL DEFAULT 'pending', -- pending | approved | flagged
    evidence              JSONB DEFAULT '{}'::jsonb,
    robot_metadata        JSONB
);

CREATE TABLE IF NOT EXISTS audit_events (
    id          BIGSERIAL PRIMARY KEY,
    block_id    TEXT REFERENCES blocks(block_id),
    event_type  TEXT NOT NULL,   -- captured | measured | classified | approved | flagged | dispatched | omeps_synced
    actor       TEXT,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS robots (
    robot_id        TEXT PRIMARY KEY,
    name            TEXT,
    status          TEXT DEFAULT 'idle',  -- idle | surveying | offline | charging
    battery_percent INTEGER,
    waypoint        TEXT,                 -- current navigation waypoint / block being approached
    blocks_measured INTEGER DEFAULT 0,
    home_quarry     TEXT,                 -- godown/dock quarry where the robot recharges
    last_gps        GEOGRAPHY(POINT, 4326),
    last_seen       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS weighbridge_records (
    id            BIGSERIAL PRIMARY KEY,
    block_id      TEXT REFERENCES blocks(block_id),
    weight_mt     DOUBLE PRECISION,
    recorded_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status);
CREATE INDEX IF NOT EXISTS idx_blocks_quarry ON blocks(quarry_id);
CREATE INDEX IF NOT EXISTS idx_audit_block ON audit_events(block_id);
