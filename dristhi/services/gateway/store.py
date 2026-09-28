"""
Persistence layer for the gateway.

Uses PostgreSQL when DATABASE_URL is set and reachable; otherwise falls back to
an in-memory store seeded with demo data so the gateway runs standalone (no DB
required) for quick demos and CI.
"""
from __future__ import annotations

import os
from typing import Optional

try:
    import psycopg
    from psycopg.rows import dict_row
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
        fee = round(vol * _RATES[cat] * (1.25 if classification == "above_gangsaw" else 1.0), 2)
        blocks.append({
            "block_id": f"QRY-{quarry['code']}-2026-{100 + i:04d}", "quarry_id": quarry["quarry_id"],
            "length_m": L, "width_m": W, "height_m": H, "volume_m3": vol,
            "confidence": round(0.86 + (i % 5) * 0.026, 2),
            "classification": classification, "granite_category": cat,
            "seigniorage_fee_inr": fee, "source": "robot", "status": _STATUSES[i % len(_STATUSES)],
            "measurement_method": "robot_stereo_pointcloud",
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
]


class MemoryStore:
    def __init__(self):
        self.blocks = {b["block_id"]: dict(b) for b in _SEED_BLOCKS}
        self.robots = {r["robot_id"]: dict(r) for r in _SEED_ROBOTS}
        self.audit: list[dict] = []
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
            return cls(conn)
        except Exception:
            return None

    _BLOCK_SELECT = (
        f"SELECT {', '.join(BLOCK_COLS)}, "
        "ST_Y(gps::geometry) AS lat, ST_X(gps::geometry) AS lon FROM blocks"
    )

    def list_blocks(self):
        return self.conn.execute(f"{self._BLOCK_SELECT} ORDER BY id").fetchall()

    def get_block(self, block_id):
        return self.conn.execute(f"{self._BLOCK_SELECT} WHERE block_id=%s", (block_id,)).fetchone()

    def upsert_block(self, b: dict):
        params = {**b, "lat": b.get("lat"), "lon": b.get("lon")}
        self.conn.execute(
            """
            INSERT INTO blocks (block_id, quarry_id, length_m, width_m, height_m, volume_m3,
                confidence, classification, granite_category, seigniorage_fee_inr, source, status,
                measurement_method, gps)
            VALUES (%(block_id)s,%(quarry_id)s,%(length_m)s,%(width_m)s,%(height_m)s,%(volume_m3)s,
                %(confidence)s,%(classification)s,%(granite_category)s,%(seigniorage_fee_inr)s,%(source)s,%(status)s,
                %(measurement_method)s,
                CASE WHEN %(lon)s IS NULL THEN NULL
                     ELSE ST_GeogFromText('POINT(' || %(lon)s || ' ' || %(lat)s || ')') END)
            ON CONFLICT (block_id) DO UPDATE SET
                length_m=EXCLUDED.length_m, width_m=EXCLUDED.width_m, height_m=EXCLUDED.height_m,
                volume_m3=EXCLUDED.volume_m3, confidence=EXCLUDED.confidence,
                classification=EXCLUDED.classification, granite_category=EXCLUDED.granite_category,
                seigniorage_fee_inr=EXCLUDED.seigniorage_fee_inr, status=EXCLUDED.status,
                measurement_method=EXCLUDED.measurement_method,
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
                CASE WHEN %(lon)s IS NULL THEN NULL
                     ELSE ST_GeogFromText('POINT(' || %(lon)s || ' ' || %(lat)s || ')') END,
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


def get_store():
    pg = PgStore.try_connect()
    if pg:
        return pg, "postgres"
    return MemoryStore(), "memory"
