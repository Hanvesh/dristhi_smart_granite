"""
Persistence layer for the gateway.

Uses PostgreSQL when DATABASE_URL is set and reachable; otherwise falls back to
an in-memory store seeded with demo data so the gateway runs standalone (no DB
required) for quick demos and CI.
"""
from __future__ import annotations

import os
import threading
from datetime import datetime, timezone
from typing import Optional

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except Exception:  # pragma: no cover
    psycopg = None

# When DATABASE_URL is unset we default to the DRISHTI Postgres. But an
# explicitly *empty* value (e.g. bootstrap.sh --no-infra sets DATABASE_URL="")
# means "no database, use the in-memory store" — so we must not fall back to a
# connection string in that case, or we'd accidentally connect to whatever
# Postgres happens to be listening on :5432 (which won't have our schema).
_RAW_DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://dristhi:dristhi@localhost:5432/dristhi")
DATABASE_URL = _RAW_DATABASE_URL.strip()

_M_PER_DEG = 111_320.0

# Real granite-bearing regions of Andhra Pradesh. Coordinates are approximate
# district/mandal centroids of well-known granite belts. code = prefix used in
# block IDs. This is the single source of truth for quarries in the demo store.
QUARRIES = [
    {"quarry_id": "APQRY-0023", "name": "Amaravati Granite Quarry", "district": "Guntur",
     "code": "AMR", "lat": 16.5734, "lon": 80.3567},
    {"quarry_id": "APQRY-0041", "name": "Ongole Black Galaxy Unit", "district": "Prakasam",
     "code": "ONG", "lat": 15.5057, "lon": 80.0447},
    {"quarry_id": "APQRY-0058", "name": "Chimakurthy Galaxy Belt", "district": "Prakasam",
     "code": "CHM", "lat": 15.5793, "lon": 79.8665},
    {"quarry_id": "APQRY-0072", "name": "Srikakulam Blue Quarry", "district": "Srikakulam",
     "code": "SKL", "lat": 18.2969, "lon": 83.8974},
    {"quarry_id": "APQRY-0089", "name": "Karimnagar Road Grey Unit", "district": "Anantapur",
     "code": "ATP", "lat": 14.6819, "lon": 77.6006},
    {"quarry_id": "APQRY-0104", "name": "Ballari Pink Belt", "district": "Kurnool",
     "code": "KNL", "lat": 15.8281, "lon": 78.0373},
]
QUARRY_BY_ID = {q["quarry_id"]: q for q in QUARRIES}

# Home quarry for the roaming reference (kept for backward-compat imports).
_QUARRY_LAT, _QUARRY_LON = QUARRIES[0]["lat"], QUARRIES[0]["lon"]


def _gps_offset(lat0, lon0, east_m, north_m):
    """Offset a lat/lon by metres (small-area approximation)."""
    import math
    dlat = north_m / _M_PER_DEG
    dlon = east_m / (_M_PER_DEG * math.cos(math.radians(lat0)))
    return round(lat0 + dlat, 6), round(lon0 + dlon, 6)


_DIMS = [
    (2.34, 1.12, 0.87), (3.10, 1.55, 1.30), (1.90, 0.95, 0.70), (2.72, 1.28, 1.05),
    (3.45, 1.62, 1.42), (2.05, 1.05, 0.80), (2.90, 1.40, 1.15), (1.75, 0.90, 0.65),
    (3.25, 1.50, 1.35), (2.50, 1.20, 0.95), (3.60, 1.70, 1.50), (2.18, 1.08, 0.82),
]
_STATUSES = ["approved", "pending", "approved", "flagged", "pending", "approved",
             "pending", "approved", "flagged", "pending", "approved", "pending"]
_CATS = ["black_galaxy", "srikakulam_blue", "generic"]
_RATES = {"black_galaxy": 2000.0, "srikakulam_blue": 1500.0, "generic": 1200.0}
# Density (MT/m3) + labels kept in sync with services/seigniorage/rules.py so the
# seeded demo blocks carry the same MT basis the live pipeline produces.
_DENSITY = {"black_galaxy": 3.0, "srikakulam_blue": 2.75, "generic": 2.65}
_CAT_LABELS = {"black_galaxy": "Black Galaxy", "srikakulam_blue": "Srikakulam Blue", "generic": "Grey/Common Granite"}


def _make_quarry_blocks(quarry, n=8):
    """Granite blocks laid out in rows across a quarry pit, GPS-tagged."""
    blocks = []
    cols, gap = 4, 28
    for i in range(n):
        L, W, H = _DIMS[i % len(_DIMS)]
        row, col = divmod(i, cols)
        east = (col - (cols - 1) / 2) * gap
        north = (row - 1) * gap - 10
        lat, lon = _gps_offset(quarry["lat"], quarry["lon"], east, north)
        vol = round(L * W * H, 2)
        classification = "above_gangsaw" if vol > 2.5 else "below_gangsaw"
        cat = _CATS[i % len(_CATS)]
        eff_rate = round(_RATES[cat] * (1.25 if classification == "above_gangsaw" else 1.0), 2)
        fee = round(vol * eff_rate, 2)
        tonnage = round(vol * _DENSITY[cat], 3)
        suffix = "Above Gangsaw" if classification == "above_gangsaw" else "Below Gangsaw"
        blocks.append({
            "block_id": f"QRY-{quarry['code']}-2026-{100 + i:04d}", "quarry_id": quarry["quarry_id"],
            "length_m": L, "width_m": W, "height_m": H, "volume_m3": vol,
            "confidence": round(0.86 + (i % 5) * 0.026, 2),
            "classification": classification, "granite_category": cat,
            "seigniorage_fee_inr": fee, "source": "robot", "status": _STATUSES[i % len(_STATUSES)],
            "measurement_method": "robot_stereo_pointcloud",
            "rate_per_m3_inr": eff_rate, "tonnage_mt": tonnage,
            "category_name": f"{_CAT_LABELS[cat]} ({suffix})",
            "lat": lat, "lon": lon,
        })
    return blocks


def _make_seed_blocks():
    # Home quarry gets the full 12; the others get 8 each -> a busy statewide map.
    blocks = _make_quarry_blocks(QUARRIES[0], 12)
    for q in QUARRIES[1:]:
        blocks += _make_quarry_blocks(q, 8)
    return blocks


_SEED_BLOCKS = _make_seed_blocks()

# Robots stationed across quarries. home_quarry marks each robot's godown/dock
# (where it recharges). BOT-01 lives at the home quarry; BOT-02 at Ongole.
_SEED_ROBOTS = [
    {"robot_id": "DRISHTI-BOT-01", "name": "Surveyor 1", "status": "idle",
     "battery_percent": 82, "blocks_measured": 47, "home_quarry": "APQRY-0023",
     "lat": QUARRIES[0]["lat"], "lon": QUARRIES[0]["lon"], "waypoint": "dock", "last_seen": None},
    {"robot_id": "DRISHTI-BOT-02", "name": "Surveyor 2", "status": "charging",
     "battery_percent": 45, "blocks_measured": 12, "home_quarry": "APQRY-0041",
     "lat": QUARRIES[1]["lat"], "lon": QUARRIES[1]["lon"], "waypoint": "charge-dock", "last_seen": None},
    {"robot_id": "DRISHTI-BOT-03", "name": "Surveyor 3", "status": "idle",
     "battery_percent": 90, "blocks_measured": 5, "home_quarry": "APQRY-0072",
     "lat": QUARRIES[3]["lat"], "lon": QUARRIES[3]["lon"], "waypoint": "dock", "last_seen": None},
]

BLOCK_COLS = [
    "block_id", "quarry_id", "length_m", "width_m", "height_m", "volume_m3",
    "confidence", "classification", "granite_category", "seigniorage_fee_inr",
    "source", "status", "measurement_method",
    "rate_per_m3_inr", "tonnage_mt", "category_name",
]

# Robot link + portal calculation/approval tables. Kept identical to
# infra/init/db/01_schema.sql; applied idempotently on startup so an existing
# database picks them up without a re-init.
ROBOT_LINK_DDL = [
    """CREATE TABLE IF NOT EXISTS robot_transmissions (
        id              BIGSERIAL PRIMARY KEY,
        msg_id          TEXT,
        device_id       TEXT,
        kid             TEXT,
        seq             BIGINT,
        content_type    TEXT,
        status          TEXT NOT NULL,
        reason          TEXT,
        size_bytes      INTEGER,
        clock_skew_s    DOUBLE PRECISION,
        payload_sha256  TEXT,
        header          JSONB,
        capture_id      TEXT,
        transport       TEXT,
        authenticated   BOOLEAN NOT NULL DEFAULT FALSE,
        received_at     TIMESTAMPTZ NOT NULL DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS idx_tx_received ON robot_transmissions(received_at DESC)",
    """CREATE TABLE IF NOT EXISTS robot_captures (
        capture_id   TEXT PRIMARY KEY,
        device_id    TEXT NOT NULL,
        quarry_id    TEXT,
        block_ref    TEXT,
        block_id     TEXT,
        captured_at  TIMESTAMPTZ,
        payload      JSONB NOT NULL,
        msg_id       TEXT,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS calculations (
        calc_id     TEXT PRIMARY KEY,
        block_id    TEXT,
        capture_id  TEXT,
        device_id   TEXT,
        quarry_id   TEXT,
        source      TEXT,
        status      TEXT NOT NULL,
        steps       JSONB,
        outputs     JSONB,
        warnings    JSONB,
        error       TEXT,
        engine      JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS idx_calc_block ON calculations(block_id)",
    """CREATE TABLE IF NOT EXISTS approvals (
        id                 BIGSERIAL PRIMARY KEY,
        block_id           TEXT REFERENCES blocks(block_id),
        decision           TEXT NOT NULL,
        actor              TEXT NOT NULL,
        role               TEXT,
        note               TEXT,
        e_transit_pass_no  TEXT,
        total_payable_inr  DOUBLE PRECISION,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now())""",
    "CREATE SEQUENCE IF NOT EXISTS e_transit_pass_seq START 4821",
]

_TX_COLS = ["msg_id", "device_id", "kid", "seq", "content_type", "status", "reason", "size_bytes",
            "clock_skew_s", "payload_sha256", "header", "capture_id", "transport", "authenticated"]
_CALC_COLS = ["calc_id", "block_id", "capture_id", "device_id", "quarry_id", "source", "status",
              "steps", "outputs", "warnings", "error", "engine", "created_at", "updated_at"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _jsonable(rec: dict) -> dict:
    """Top-level datetimes -> ISO strings (memory store keeps JSON-ready rows)."""
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in rec.items()}


def _ts(v):
    """ISO string -> aware datetime for timestamptz params (psycopg)."""
    if isinstance(v, str):
        return datetime.fromisoformat(v)
    return v


class MemoryStore:
    def __init__(self):
        self.blocks = {b["block_id"]: dict(b) for b in _SEED_BLOCKS}
        self.robots = {r["robot_id"]: dict(r) for r in _SEED_ROBOTS}
        self.audit: list[dict] = []
        self.transmissions: list[dict] = []
        self.captures: dict[str, dict] = {}
        self.calculations: dict[str, dict] = {}
        self.approvals: list[dict] = []
        self._etp_seq = 4820
        self._lock = threading.Lock()
        self._seed_audit()

    def _seed_audit(self):
        """Give the pre-seeded blocks a realistic lifecycle history so the audit
        trail / traceability view is populated on a fresh demo (requirement 5)."""
        from datetime import datetime, timedelta, timezone
        base = datetime.now(timezone.utc) - timedelta(hours=6)
        step = 0
        for b in _SEED_BLOCKS:
            bid = b["block_id"]
            actor_bot = "DRISHTI-BOT-01" if b["source"] == "robot" else "mobile-app"

            def ts(mins):
                return (base + timedelta(minutes=step * 7 + mins)).isoformat()

            self.audit.append({"block_id": bid, "event_type": "measured", "actor": actor_bot,
                               "detail": {"method": b["measurement_method"], "confidence": b["confidence"]},
                               "created_at": ts(0)})
            self.audit.append({"block_id": bid, "event_type": "classified", "actor": "seigniorage-engine",
                               "detail": {"class": b["classification"], "fee_inr": b["seigniorage_fee_inr"]},
                               "created_at": ts(1)})
            if b["status"] == "approved":
                self.audit.append({"block_id": bid, "event_type": "omeps_synced", "actor": "officer",
                                   "detail": {"anomaly": False, "message": "Synced to OMEPS 2.0"},
                                   "created_at": ts(2)})
                self.audit.append({"block_id": bid, "event_type": "approved", "actor": "officer",
                                   "detail": {}, "created_at": ts(3)})
            elif b["status"] == "flagged":
                self.audit.append({"block_id": bid, "event_type": "omeps_synced", "actor": "officer",
                                   "detail": {"anomaly": True, "divergence": 0.21,
                                              "message": "AI vs weighbridge divergence exceeds tolerance"},
                                   "created_at": ts(2)})
                self.audit.append({"block_id": bid, "event_type": "flagged", "actor": "officer",
                                   "detail": {"reason": "OMEPS anomaly"}, "created_at": ts(3)})
            step += 1

    def list_quarries(self):
        return [dict(q) for q in QUARRIES]

    def get_robot(self, robot_id):
        return self.robots.get(robot_id)

    def list_blocks(self):
        return list(self.blocks.values())

    def get_block(self, block_id):
        return self.blocks.get(block_id)

    def upsert_block(self, block: dict):
        self.blocks[block["block_id"]] = {**self.blocks.get(block["block_id"], {}), **block}
        return self.blocks[block["block_id"]]

    def set_status(self, block_id, status):
        if block_id in self.blocks:
            self.blocks[block_id]["status"] = status
            return self.blocks[block_id]
        return None

    def add_audit(self, block_id, event_type, actor, detail):
        from datetime import datetime, timezone
        self.audit.append({
            "block_id": block_id, "event_type": event_type, "actor": actor,
            "detail": detail, "created_at": datetime.now(timezone.utc).isoformat(),
        })

    def list_audit(self, block_id=None, limit=200):
        events = [e for e in self.audit if block_id is None or e["block_id"] == block_id]
        # newest first
        return list(reversed(events))[:limit]

    def list_robots(self):
        return list(self.robots.values())

    def set_robot_status(self, robot_id, status):
        if robot_id in self.robots:
            self.robots[robot_id]["status"] = status
            return self.robots[robot_id]
        return None

    def update_robot_telemetry(self, robot_id, telemetry: dict):
        r = self.robots.get(robot_id)
        if r is None:
            # Auto-register a robot that comes online via IoT.
            r = {"robot_id": robot_id, "name": robot_id, "blocks_measured": 0}
            self.robots[robot_id] = r
        for k in ("status", "battery_percent", "lat", "lon", "waypoint", "last_seen"):
            if k in telemetry and telemetry[k] is not None:
                r[k] = telemetry[k]
        return r

    def increment_robot_blocks(self, robot_id):
        r = self.robots.get(robot_id)
        if r is not None:
            r["blocks_measured"] = (r.get("blocks_measured") or 0) + 1

    def set_status_if(self, block_id, status, allowed: tuple):
        """Atomically move a block to `status` only if it is currently in one
        of `allowed` (prevents double approvals). Returns the block or None."""
        with self._lock:
            b = self.blocks.get(block_id)
            if not b or b.get("status") not in allowed:
                return None
            b["status"] = status
            return dict(b)

    def allocate_block_id(self, base: str) -> str:
        if base not in self.blocks:
            return base
        n = 2
        while f"{base}-R{n}" in self.blocks:
            n += 1
        return f"{base}-R{n}"

    def latest_audit_by_type(self, event_type: str) -> dict:
        out = {}
        for e in self.audit:  # chronological, so later events win
            if e["event_type"] == event_type:
                out[e["block_id"]] = e
        return out

    # ---- robot link: transmission log + raw captures ----
    def add_transmission(self, rec: dict) -> dict:
        with self._lock:
            row = {"id": (self.transmissions[-1]["id"] + 1) if self.transmissions else 1,
                   **_jsonable(rec)}
            row.setdefault("received_at", _now_iso())
            self.transmissions.append(row)
            if len(self.transmissions) > 5000:
                del self.transmissions[:-5000]
        return row

    def list_transmissions(self, limit=100):
        with self._lock:
            rows = [dict(t) for t in self.transmissions[-limit:]]
        out = []
        for t in reversed(rows):
            cap = self.captures.get(t.get("capture_id") or "")
            t["block_id"] = cap.get("block_id") if cap else None
            t["payload"] = cap["payload"] if cap and t.get("status") == "accepted" else None
            out.append(t)
        return out

    def add_capture(self, rec: dict) -> bool:
        """Insert a raw capture; False if the capture_id already exists."""
        with self._lock:
            if rec["capture_id"] in self.captures:
                return False
            self.captures[rec["capture_id"]] = _jsonable(rec)
            return True

    def get_capture(self, capture_id):
        c = self.captures.get(capture_id)
        return dict(c) if c else None

    def set_capture_block(self, capture_id, block_id):
        with self._lock:
            if capture_id in self.captures:
                self.captures[capture_id]["block_id"] = block_id

    # ---- calculations ----
    def upsert_calculation(self, calc: dict) -> dict:
        with self._lock:
            prev = self.calculations.get(calc["calc_id"], {})
            row = {**prev, **_jsonable(calc)}
            if prev.get("created_at"):
                row["created_at"] = prev["created_at"]
            self.calculations[calc["calc_id"]] = row
            return dict(row)

    def get_calculation(self, calc_id):
        c = self.calculations.get(calc_id)
        return dict(c) if c else None

    def get_calculation_for_block(self, block_id):
        matches = [c for c in self.calculations.values() if c.get("block_id") == block_id]
        return dict(max(matches, key=lambda c: c.get("updated_at") or "")) if matches else None

    def list_calculations(self, limit=100):
        rows = sorted(self.calculations.values(), key=lambda c: c.get("created_at") or "", reverse=True)
        return [dict(c) for c in rows[:limit]]

    # ---- approvals ----
    def add_approval(self, rec: dict) -> dict:
        with self._lock:
            row = {"id": len(self.approvals) + 1, "created_at": _now_iso(), **rec}
            self.approvals.append(row)
            return dict(row)

    def list_approvals(self, limit=100):
        return [dict(a) for a in reversed(self.approvals)][:limit]

    def next_e_transit_pass_no(self) -> str:
        with self._lock:
            self._etp_seq += 1
            return f"ETP-AP-{self._etp_seq}"


class PgStore:
    def __init__(self, conn):
        self.conn = conn

    @classmethod
    def try_connect(cls) -> Optional["PgStore"]:
        # Empty DATABASE_URL => caller explicitly wants the in-memory store.
        if psycopg is None or not DATABASE_URL:
            return None
        try:
            conn = psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True, connect_timeout=3)
            # Only use Postgres if the DRISHTI schema is actually present.
            # Otherwise we'd have connected to some unrelated local Postgres and
            # every query would 500 mid-demo. Fall back to memory instead.
            row = conn.execute(
                "SELECT to_regclass('public.blocks') IS NOT NULL "
                "AND to_regclass('public.robots') IS NOT NULL AS ready"
            ).fetchone()
            if not row or not row.get("ready"):
                conn.close()
                return None
            store = cls(conn)
            # Self-heal schema drift: a Postgres created from an older schema may
            # be missing columns the gateway now depends on (waypoint,
            # blocks_measured, home_quarry). Without this, every /robots query
            # 500s and the robot never moves. These migrations are idempotent.
            store._ensure_schema()
            return store
        except Exception:
            return None

    def _ensure_schema(self):
        """Add any columns the current code depends on but an older DB lacks,
        then seed robots/quarries if the tables are empty. All statements are
        idempotent so this is safe to run on every startup."""
        try:
            self.conn.execute(
                "ALTER TABLE robots ADD COLUMN IF NOT EXISTS waypoint TEXT"
            )
            self.conn.execute(
                "ALTER TABLE robots ADD COLUMN IF NOT EXISTS blocks_measured INTEGER DEFAULT 0"
            )
            self.conn.execute(
                "ALTER TABLE robots ADD COLUMN IF NOT EXISTS home_quarry TEXT"
            )
            self.conn.execute(
                "ALTER TABLE robots ADD COLUMN IF NOT EXISTS last_gps geography(Point,4326)"
            )
            self.conn.execute(
                "ALTER TABLE robots ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ"
            )
            # Enriched seigniorage/MT-basis columns on blocks (kept in sync with
            # the seigniorage engine + both UIs).
            self.conn.execute(
                "ALTER TABLE blocks ADD COLUMN IF NOT EXISTS rate_per_m3_inr DOUBLE PRECISION"
            )
            self.conn.execute(
                "ALTER TABLE blocks ADD COLUMN IF NOT EXISTS tonnage_mt DOUBLE PRECISION"
            )
            self.conn.execute(
                "ALTER TABLE blocks ADD COLUMN IF NOT EXISTS category_name TEXT"
            )
            self._seed_if_empty()
        except Exception as e:  # pragma: no cover
            print(f"[store] schema self-heal skipped: {e}")
        try:
            for ddl in ROBOT_LINK_DDL:
                self.conn.execute(ddl)
        except Exception as e:  # pragma: no cover
            print(f"[store] robot-link schema skipped: {e}")

    def _seed_if_empty(self):
        """Ensure the demo quarries and robots exist so the console has fleet
        data (and the roam engine has a home quarry) even on a bare database."""
        try:
            # Robot View pits (quarry_registry) must exist too, or blocks
            # captured there would violate blocks.quarry_id's foreign key.
            from quarry_registry import ROBOT_QUARRIES
            for q in [*QUARRIES, *ROBOT_QUARRIES]:
                self.conn.execute(
                    "INSERT INTO quarries (quarry_id, name, district, location) "
                    "VALUES (%(quarry_id)s, %(name)s, %(district)s, "
                    "ST_GeogFromText('POINT(' || %(lon)s || ' ' || %(lat)s || ')')) "
                    "ON CONFLICT (quarry_id) DO NOTHING",
                    q,
                )
            row = self.conn.execute("SELECT COUNT(*) AS n FROM robots").fetchone()
            if row and (row.get("n") or 0) == 0:
                for r in _SEED_ROBOTS:
                    q = QUARRY_BY_ID.get(r["home_quarry"], QUARRIES[0])
                    self.conn.execute(
                        "INSERT INTO robots (robot_id, name, status, battery_percent, "
                        "waypoint, blocks_measured, home_quarry, last_gps, last_seen) "
                        "VALUES (%(robot_id)s, %(name)s, %(status)s, %(battery_percent)s, "
                        "%(waypoint)s, %(blocks_measured)s, %(home_quarry)s, "
                        "ST_GeogFromText('POINT(' || %(lon)s || ' ' || %(lat)s || ')'), now()) "
                        "ON CONFLICT (robot_id) DO NOTHING",
                        {**r, "lat": q["lat"], "lon": q["lon"]},
                    )
        except Exception as e:  # pragma: no cover
            print(f"[store] seed skipped: {e}")

    _BLOCK_SELECT = (
        f"SELECT {', '.join(BLOCK_COLS)}, "
        "ST_Y(gps::geometry) AS lat, ST_X(gps::geometry) AS lon FROM blocks"
    )

    def list_blocks(self):
        return self.conn.execute(f"{self._BLOCK_SELECT} ORDER BY id").fetchall()

    def get_block(self, block_id):
        return self.conn.execute(f"{self._BLOCK_SELECT} WHERE block_id=%s", (block_id,)).fetchone()

    def upsert_block(self, b: dict):
        params = {
            "rate_per_m3_inr": None, "tonnage_mt": None, "category_name": None,
            **b, "lat": b.get("lat"), "lon": b.get("lon"),
        }
        self.conn.execute(
            """
            INSERT INTO blocks (block_id, quarry_id, length_m, width_m, height_m, volume_m3,
                confidence, classification, granite_category, seigniorage_fee_inr, source, status,
                measurement_method, rate_per_m3_inr, tonnage_mt, category_name, gps)
            VALUES (%(block_id)s,%(quarry_id)s,%(length_m)s,%(width_m)s,%(height_m)s,%(volume_m3)s,
                %(confidence)s,%(classification)s,%(granite_category)s,%(seigniorage_fee_inr)s,%(source)s,%(status)s,
                %(measurement_method)s,%(rate_per_m3_inr)s,%(tonnage_mt)s,%(category_name)s,
                CASE WHEN %(lon)s::float8 IS NULL THEN NULL
                     ELSE ST_GeogFromText('POINT(' || %(lon)s::float8 || ' ' || %(lat)s::float8 || ')') END)
            ON CONFLICT (block_id) DO UPDATE SET
                length_m=EXCLUDED.length_m, width_m=EXCLUDED.width_m, height_m=EXCLUDED.height_m,
                volume_m3=EXCLUDED.volume_m3, confidence=EXCLUDED.confidence,
                classification=EXCLUDED.classification, granite_category=EXCLUDED.granite_category,
                seigniorage_fee_inr=EXCLUDED.seigniorage_fee_inr, status=EXCLUDED.status,
                measurement_method=EXCLUDED.measurement_method,
                rate_per_m3_inr=EXCLUDED.rate_per_m3_inr, tonnage_mt=EXCLUDED.tonnage_mt,
                category_name=EXCLUDED.category_name,
                gps=COALESCE(EXCLUDED.gps, blocks.gps)
            """,
            params,
        )
        return self.get_block(b["block_id"])

    def set_status(self, block_id, status):
        self.conn.execute("UPDATE blocks SET status=%s WHERE block_id=%s", (status, block_id))
        return self.get_block(block_id)

    def add_audit(self, block_id, event_type, actor, detail):
        import json
        self.conn.execute(
            "INSERT INTO audit_events (block_id, event_type, actor, detail) VALUES (%s,%s,%s,%s)",
            (block_id, event_type, actor, json.dumps(detail)),
        )

    def list_audit(self, block_id=None, limit=200):
        if block_id is None:
            return self.conn.execute(
                "SELECT block_id, event_type, actor, detail, created_at "
                "FROM audit_events ORDER BY created_at DESC, id DESC LIMIT %s",
                (limit,),
            ).fetchall()
        return self.conn.execute(
            "SELECT block_id, event_type, actor, detail, created_at "
            "FROM audit_events WHERE block_id=%s ORDER BY created_at DESC, id DESC LIMIT %s",
            (block_id, limit),
        ).fetchall()

    def list_quarries(self):
        rows = self.conn.execute(
            "SELECT quarry_id, name, district, ST_Y(location::geometry) AS lat, "
            "ST_X(location::geometry) AS lon FROM quarries ORDER BY quarry_id"
        ).fetchall()
        # Attach the block-id code from the static registry when available.
        for r in rows:
            q = QUARRY_BY_ID.get(r["quarry_id"])
            r["code"] = q["code"] if q else r["quarry_id"]
        return rows

    _ROBOT_SELECT = (
        "SELECT robot_id, name, status, battery_percent, waypoint, home_quarry, "
        "COALESCE(blocks_measured,0) AS blocks_measured, "
        "ST_Y(last_gps::geometry) AS lat, ST_X(last_gps::geometry) AS lon, "
        "last_seen FROM robots"
    )

    def list_robots(self):
        return self.conn.execute(f"{self._ROBOT_SELECT} ORDER BY robot_id").fetchall()

    def get_robot(self, robot_id):
        return self._get_robot(robot_id)

    def _get_robot(self, robot_id):
        return self.conn.execute(f"{self._ROBOT_SELECT} WHERE robot_id=%s", (robot_id,)).fetchone()

    def set_robot_status(self, robot_id, status):
        self.conn.execute("UPDATE robots SET status=%s WHERE robot_id=%s", (status, robot_id))
        return self._get_robot(robot_id)

    def update_robot_telemetry(self, robot_id, telemetry: dict):
        lat = telemetry.get("lat")
        lon = telemetry.get("lon")
        self.conn.execute(
            """
            INSERT INTO robots (robot_id, name, status, battery_percent, waypoint,
                last_gps, last_seen)
            VALUES (%(robot_id)s, %(name)s, %(status)s, %(battery_percent)s, %(waypoint)s,
                CASE WHEN %(lon)s::float8 IS NULL THEN NULL
                     ELSE ST_GeogFromText('POINT(' || %(lon)s::float8 || ' ' || %(lat)s::float8 || ')') END,
                now())
            ON CONFLICT (robot_id) DO UPDATE SET
                status=COALESCE(EXCLUDED.status, robots.status),
                battery_percent=COALESCE(EXCLUDED.battery_percent, robots.battery_percent),
                waypoint=COALESCE(EXCLUDED.waypoint, robots.waypoint),
                last_gps=COALESCE(EXCLUDED.last_gps, robots.last_gps),
                last_seen=now()
            """,
            {"robot_id": robot_id, "name": telemetry.get("name", robot_id),
             "status": telemetry.get("status"), "battery_percent": telemetry.get("battery_percent"),
             "waypoint": telemetry.get("waypoint"), "lat": lat, "lon": lon},
        )
        return self._get_robot(robot_id)

    def increment_robot_blocks(self, robot_id):
        self.conn.execute(
            "UPDATE robots SET blocks_measured=COALESCE(blocks_measured,0)+1 WHERE robot_id=%s",
            (robot_id,),
        )

    def set_status_if(self, block_id, status, allowed: tuple):
        row = self.conn.execute(
            "UPDATE blocks SET status=%s WHERE block_id=%s AND status = ANY(%s) RETURNING block_id",
            (status, block_id, list(allowed)),
        ).fetchone()
        return self.get_block(block_id) if row else None

    def allocate_block_id(self, base: str) -> str:
        rows = self.conn.execute(
            "SELECT block_id FROM blocks WHERE block_id = %s OR block_id LIKE %s",
            (base, f"{base}-R%"),
        ).fetchall()
        taken = {r["block_id"] for r in rows}
        if base not in taken:
            return base
        n = 2
        while f"{base}-R{n}" in taken:
            n += 1
        return f"{base}-R{n}"

    def latest_audit_by_type(self, event_type: str) -> dict:
        rows = self.conn.execute(
            "SELECT DISTINCT ON (block_id) block_id, event_type, actor, detail, created_at "
            "FROM audit_events WHERE event_type=%s ORDER BY block_id, created_at DESC, id DESC",
            (event_type,),
        ).fetchall()
        return {r["block_id"]: r for r in rows}

    # ---- robot link: transmission log + raw captures ----
    def add_transmission(self, rec: dict) -> dict:
        params = {c: rec.get(c) for c in _TX_COLS}
        params["header"] = Jsonb(rec.get("header") or {})
        params["authenticated"] = bool(rec.get("authenticated"))
        params["received_at"] = _ts(rec.get("received_at")) or datetime.now(timezone.utc)
        cols = [*_TX_COLS, "received_at"]
        row = self.conn.execute(
            f"INSERT INTO robot_transmissions ({', '.join(cols)}) "
            f"VALUES ({', '.join(f'%({c})s' for c in cols)}) RETURNING id",
            params,
        ).fetchone()
        return {**rec, "id": row["id"]}

    def list_transmissions(self, limit=100):
        return self.conn.execute(
            "SELECT t.id, t.msg_id, t.device_id, t.kid, t.seq, t.content_type, t.status, t.reason, "
            "t.size_bytes, t.clock_skew_s, t.payload_sha256, t.header, t.capture_id, t.transport, "
            "t.authenticated, t.received_at, c.block_id, "
            "CASE WHEN t.status = 'accepted' THEN c.payload END AS payload "
            "FROM robot_transmissions t LEFT JOIN robot_captures c ON c.capture_id = t.capture_id "
            "ORDER BY t.received_at DESC, t.id DESC LIMIT %s",
            (limit,),
        ).fetchall()

    def add_capture(self, rec: dict) -> bool:
        row = self.conn.execute(
            "INSERT INTO robot_captures (capture_id, device_id, quarry_id, block_ref, block_id, "
            "captured_at, payload, msg_id, received_at) "
            "VALUES (%(capture_id)s, %(device_id)s, %(quarry_id)s, %(block_ref)s, %(block_id)s, "
            "%(captured_at)s, %(payload)s, %(msg_id)s, %(received_at)s) "
            "ON CONFLICT (capture_id) DO NOTHING RETURNING capture_id",
            {**rec, "payload": Jsonb(rec["payload"]), "captured_at": _ts(rec.get("captured_at")),
             "received_at": _ts(rec.get("received_at")) or datetime.now(timezone.utc)},
        ).fetchone()
        return row is not None

    def get_capture(self, capture_id):
        return self.conn.execute(
            "SELECT capture_id, device_id, quarry_id, block_ref, block_id, captured_at, payload, "
            "msg_id, received_at FROM robot_captures WHERE capture_id=%s",
            (capture_id,),
        ).fetchone()

    def set_capture_block(self, capture_id, block_id):
        self.conn.execute("UPDATE robot_captures SET block_id=%s WHERE capture_id=%s", (block_id, capture_id))

    # ---- calculations ----
    def upsert_calculation(self, calc: dict) -> dict:
        params = {c: calc.get(c) for c in _CALC_COLS}
        for col, empty in (("steps", []), ("outputs", {}), ("warnings", []), ("engine", {})):
            value = calc.get(col)
            params[col] = Jsonb(value if value is not None else empty)
        now = datetime.now(timezone.utc)
        params["created_at"] = _ts(calc.get("created_at")) or now
        params["updated_at"] = _ts(calc.get("updated_at")) or now
        updatable = [c for c in _CALC_COLS if c not in ("calc_id", "created_at")]
        self.conn.execute(
            f"INSERT INTO calculations ({', '.join(_CALC_COLS)}) "
            f"VALUES ({', '.join(f'%({c})s' for c in _CALC_COLS)}) "
            f"ON CONFLICT (calc_id) DO UPDATE SET {', '.join(f'{c}=EXCLUDED.{c}' for c in updatable)}",
            params,
        )
        return self.get_calculation(calc["calc_id"])

    _CALC_SELECT = f"SELECT {', '.join(_CALC_COLS)} FROM calculations"

    def get_calculation(self, calc_id):
        return self.conn.execute(f"{self._CALC_SELECT} WHERE calc_id=%s", (calc_id,)).fetchone()

    def get_calculation_for_block(self, block_id):
        return self.conn.execute(
            f"{self._CALC_SELECT} WHERE block_id=%s ORDER BY updated_at DESC LIMIT 1", (block_id,)
        ).fetchone()

    def list_calculations(self, limit=100):
        return self.conn.execute(
            f"{self._CALC_SELECT} ORDER BY created_at DESC LIMIT %s", (limit,)
        ).fetchall()

    # ---- approvals ----
    def add_approval(self, rec: dict) -> dict:
        return self.conn.execute(
            "INSERT INTO approvals (block_id, decision, actor, role, note, e_transit_pass_no, total_payable_inr) "
            "VALUES (%(block_id)s, %(decision)s, %(actor)s, %(role)s, %(note)s, %(e_transit_pass_no)s, "
            "%(total_payable_inr)s) RETURNING id, block_id, decision, actor, role, note, e_transit_pass_no, "
            "total_payable_inr, created_at",
            {"role": None, "note": None, "e_transit_pass_no": None, "total_payable_inr": None, **rec},
        ).fetchone()

    def list_approvals(self, limit=100):
        return self.conn.execute(
            "SELECT id, block_id, decision, actor, role, note, e_transit_pass_no, total_payable_inr, created_at "
            "FROM approvals ORDER BY created_at DESC, id DESC LIMIT %s",
            (limit,),
        ).fetchall()

    def next_e_transit_pass_no(self) -> str:
        row = self.conn.execute("SELECT nextval('e_transit_pass_seq') AS n").fetchone()
        return f"ETP-AP-{row['n']}"


def get_store():
    pg = PgStore.try_connect()
    if pg:
        return pg, "postgres"
    return MemoryStore(), "memory"
