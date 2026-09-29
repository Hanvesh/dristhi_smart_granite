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
    rate_per_m3_inr       DOUBLE PRECISION, -- effective per-m3 rate (incl. above-gangsaw premium)
    tonnage_mt            DOUBLE PRECISION, -- MT basis (volume x density)
    category_name         TEXT,             -- e.g. "Black Galaxy (Above Gangsaw)"
    source                TEXT NOT NULL,    -- mobile | robot
    status                TEXT NOT NULL DEFAULT 'pending', -- pending | approved | flagged | rejected
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

-- ── Secure robot link: robots transmit raw captures only ────────────────────
-- Every envelope the gateway receives (accepted, duplicate or rejected + why).
-- Keys are never stored; only envelope metadata and the plaintext's SHA-256.
CREATE TABLE IF NOT EXISTS robot_transmissions (
    id              BIGSERIAL PRIMARY KEY,
    msg_id          TEXT,               -- JWE header "jti" (single-use message id)
    device_id       TEXT,
    kid             TEXT,               -- robot-link session key id
    seq             BIGINT,             -- per-session sequence (single-use, anti-replay window)
    content_type    TEXT,               -- capture | telemetry
    status          TEXT NOT NULL,      -- accepted | duplicate | rejected
    reason          TEXT,
    size_bytes      INTEGER,
    clock_skew_s    DOUBLE PRECISION,
    payload_sha256  TEXT,
    header          JSONB,              -- protected header (claimed/unauthenticated when rejected)
    capture_id      TEXT,
    transport       TEXT,               -- http | aws-iot
    authenticated   BOOLEAN NOT NULL DEFAULT FALSE,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_received ON robot_transmissions(received_at DESC);

-- Raw sensor payloads exactly as validated (drishti.robot.capture/v1).
CREATE TABLE IF NOT EXISTS robot_captures (
    capture_id   TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    quarry_id    TEXT,
    block_ref    TEXT,
    block_id     TEXT,                  -- assigned by the portal pipeline
    captured_at  TIMESTAMPTZ,
    payload      JSONB NOT NULL,
    msg_id       TEXT,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Portal-side calculation records: inputs, every step + formula, outputs.
CREATE TABLE IF NOT EXISTS calculations (
    calc_id     TEXT PRIMARY KEY,       -- capture_id for robot captures, else block_id
    block_id    TEXT,
    capture_id  TEXT,
    device_id   TEXT,
    quarry_id   TEXT,
    source      TEXT,
    status      TEXT NOT NULL,          -- running | completed | failed
    steps       JSONB,
    outputs     JSONB,
    warnings    JSONB,
    error       TEXT,
    engine      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calc_block ON calculations(block_id);

-- Officer decisions (approve issues an e-transit pass number).
CREATE TABLE IF NOT EXISTS approvals (
    id                 BIGSERIAL PRIMARY KEY,
    block_id           TEXT REFERENCES blocks(block_id),
    decision           TEXT NOT NULL,   -- approved | rejected
    actor              TEXT NOT NULL,
    role               TEXT,
    note               TEXT,
    e_transit_pass_no  TEXT,
    total_payable_inr  DOUBLE PRECISION,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS e_transit_pass_seq START 4821;
