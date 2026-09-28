"""
DRISHTI API Gateway (FastAPI).

Orchestrates the capture -> measure -> assess -> persist -> (OMEPS sync) flow and
serves the two UIs. This is the open-source, lightweight gateway that runs with
zero extra prerequisites (falls back to an in-memory store if Postgres is down).

A Spring Boot 3 / Java 21 equivalent skeleton lives in ./springboot for teams
that prefer the JVM stack from the proposal; the REST contract is identical.

Security: bearer-token aware. In demo mode any 'demo.<user>.<role>' token is
accepted and its role parsed from the token. Wire real Keycloak JWT validation
in verify_token() for production.
"""
import os
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from store import get_store
from iot_bridge import IoTBridge
from roam_engine import RoamEngine

VISION_URL = os.getenv("VISION_URL", "http://localhost:8001")
SEIGNIORAGE_URL = os.getenv("SEIGNIORAGE_URL", "http://localhost:8002")
OMEPS_URL = os.getenv("OMEPS_URL", "http://localhost:8003")

store, store_kind = get_store()


# ---- Robot ingestion pipeline (shared by HTTP + AWS IoT bridge) -----------
def ingest_block(robot_id: str, data: dict) -> dict:
    """Run a measured block through measure -> assess -> persist. Used by the
    /captures endpoint, by robot telemetry-driven blocks, and by the IoT bridge."""
    block_id = data["block_id"]
    quarry_id = data.get("quarry_id", "APQRY-0023")
    source = data.get("source", "robot")
    granite_category = data.get("granite_category", "generic")
    with httpx.Client(timeout=10) as client:
        m = client.post(f"{VISION_URL}/measure", json={
            "block_id": block_id, "source": source, "image_ref": data.get("image_ref"),
        }).json()
        a = client.post(f"{SEIGNIORAGE_URL}/assess", json={
            "volume_m3": m["volume_m3"], "granite_category": granite_category,
        }).json()
    block = {
        "block_id": block_id, "quarry_id": quarry_id,
        "length_m": m["length_m"], "width_m": m["width_m"], "height_m": m["height_m"],
        "volume_m3": m["volume_m3"], "confidence": m["confidence"],
        "classification": a["classification"], "granite_category": a["granite_category"],
        "seigniorage_fee_inr": a["seigniorage_fee_inr"], "source": source,
        "status": "pending", "measurement_method": m["measurement_method"],
        "lat": data.get("lat"), "lon": data.get("lon"),
    }
    saved = store.upsert_block(block)
    store.add_audit(block_id, "measured", robot_id, {"method": m["measurement_method"], "via": data.get("via", "http")})
    store.add_audit(block_id, "classified", "seigniorage-engine", {"class": a["classification"]})
    if source == "robot":
        store.increment_robot_blocks(robot_id)
    return saved


def _on_iot_telemetry(robot_id: str, data: dict):
    store.update_robot_telemetry(robot_id, data)


def _on_iot_block(robot_id: str, data: dict):
    data.setdefault("via", "aws-iot")
    ingest_block(robot_id, data)


bridge = IoTBridge(on_telemetry=_on_iot_telemetry, on_block=_on_iot_block)

# Server-side roam engine: drives the robot when "Start survey" is clicked in
# the UI (replaces running robot/sim_agent.py by hand). It updates telemetry in
# the store and measures blocks through the same ingest_block pipeline.
roam = RoamEngine(
    update_telemetry=lambda rid, data: store.update_robot_telemetry(rid, data),
    ingest_block=ingest_block,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    bridge.start()
    yield


app = FastAPI(title="DRISHTI API Gateway", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---- Auth (demo-mode token parsing; replace with Keycloak JWT in prod) ----
class Principal(BaseModel):
    username: str
    role: str


def verify_token(authorization: Optional[str] = Header(None)) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        # Allow anonymous reads in demo mode; role 'anonymous'
        return Principal(username="anonymous", role="anonymous")
    token = authorization.split(" ", 1)[1]
    parts = token.split(".")
    if len(parts) == 3 and parts[0] == "demo":
        return Principal(username=parts[1], role=parts[2])
    # Unknown token format -> treat as authenticated officer in demo. Replace in prod.
    return Principal(username="token-user", role="officer")


def require_role(*roles):
    def dep(p: Principal = Depends(verify_token)) -> Principal:
        if p.role not in roles and p.role != "admin":
            raise HTTPException(status_code=403, detail=f"requires one of {roles}")
        return p
    return dep


# ---- Models ----
class CaptureRequest(BaseModel):
    block_id: str
    quarry_id: str
    source: str = "mobile"
    image_ref: Optional[str] = None
    granite_category: str = "generic"
    weighbridge_weight_mt: Optional[float] = None


# ---- Health ----
@app.get("/health")
def health():
    return {"status": "ok", "store": store_kind, "iot": bridge.status()}


# ---- Blocks ----
@app.get("/blocks")
def list_blocks(_: Principal = Depends(verify_token)):
    return store.list_blocks()


@app.get("/blocks/{block_id}")
def get_block(block_id: str, _: Principal = Depends(verify_token)):
    b = store.get_block(block_id)
    if not b:
        raise HTTPException(404, "block not found")
    return b


@app.post("/blocks/{block_id}/approve")
def approve(block_id: str, p: Principal = Depends(require_role("officer"))):
    b = store.set_status(block_id, "approved")
    if not b:
        raise HTTPException(404, "block not found")
    store.add_audit(block_id, "approved", p.username, {})
    return b


@app.post("/blocks/{block_id}/flag")
def flag(block_id: str, p: Principal = Depends(require_role("officer"))):
    b = store.set_status(block_id, "flagged")
    if not b:
        raise HTTPException(404, "block not found")
    store.add_audit(block_id, "flagged", p.username, {})
    return b


# ---- Capture pipeline: measure -> assess -> persist ----
@app.post("/captures")
def create_capture(req: CaptureRequest, p: Principal = Depends(verify_token)):
    actor = p.username if p.username != "anonymous" else "mobile"
    return ingest_block(actor, {
        "block_id": req.block_id, "quarry_id": req.quarry_id, "source": req.source,
        "image_ref": req.image_ref, "granite_category": req.granite_category, "via": "http",
    })


# ---- OMEPS 2.0 cross-validation sync ----
@app.post("/omeps/sync/{block_id}")
def omeps_sync(block_id: str, weighbridge_weight_mt: Optional[float] = None,
               p: Principal = Depends(require_role("officer", "admin"))):
    b = store.get_block(block_id)
    if not b:
        raise HTTPException(404, "block not found")
    with httpx.Client(timeout=10) as client:
        res = client.post(f"{OMEPS_URL}/sync", json={
            "block_id": block_id, "ai_volume_m3": b["volume_m3"],
            "weighbridge_weight_mt": weighbridge_weight_mt,
        }).json()
    store.add_audit(block_id, "omeps_synced", p.username, res)
    if res.get("anomaly"):
        store.set_status(block_id, "flagged")
    return res


# ---- Analytics ----
@app.get("/analytics/summary")
def analytics(_: Principal = Depends(verify_token)):
    blocks = store.list_blocks()
    return {
        "total": len(blocks),
        "approved": sum(1 for b in blocks if b["status"] == "approved"),
        "pending": sum(1 for b in blocks if b["status"] == "pending"),
        "anomalies": sum(1 for b in blocks if b["status"] == "flagged"),
        "revenue_inr": round(sum(b["seigniorage_fee_inr"] or 0 for b in blocks), 2),
    }


# ---- Quarries ----
@app.get("/quarries")
def quarries(_: Principal = Depends(verify_token)):
    return store.list_quarries()


# ---- Robots ----
@app.get("/robots")
def robots(_: Principal = Depends(verify_token)):
    return store.list_robots()


@app.post("/robots/{robot_id}/survey")
def start_survey(robot_id: str, blocks: int = 6, step_sec: float = 0.6,
                 p: Principal = Depends(require_role("robot-operator", "admin"))):
    """Start an autonomous survey. Launches the server-side roam engine so the
    robot actually roams (streams telemetry + measures blocks) — the same
    behaviour that used to require running robot/sim_agent.py in a terminal."""
    robot = store.get_robot(robot_id)
    if not robot:
        raise HTTPException(404, "robot not found")
    # Roam around the robot's home quarry (its godown), not a fixed point.
    home_id = robot.get("home_quarry") or "APQRY-0023"
    from store import QUARRY_BY_ID
    q = QUARRY_BY_ID.get(home_id, QUARRY_BY_ID["APQRY-0023"])
    battery = robot.get("battery_percent")
    robot = store.set_robot_status(robot_id, "surveying")
    roam.start(robot_id, quarry_id=home_id, home_lat=q["lat"], home_lon=q["lon"],
               blocks=max(1, min(blocks, 30)), step_sec=max(0.05, min(step_sec, 5.0)),
               battery=float(battery) if battery is not None else 100.0)
    store.add_audit(robot_id, "survey_started", p.username, {"blocks": blocks, "quarry": home_id})
    return robot


@app.post("/robots/{robot_id}/survey/stop")
def stop_survey(robot_id: str, p: Principal = Depends(require_role("robot-operator", "admin"))):
    """Stop the survey: signal the roam engine to finish and return to dock."""
    if not store.set_robot_status(robot_id, "idle"):
        raise HTTPException(404, "robot not found")
    roam.stop(robot_id)
    store.add_audit(robot_id, "survey_stopped", p.username, {})
    return store.set_robot_status(robot_id, "idle")


class Telemetry(BaseModel):
    status: Optional[str] = None
    battery_percent: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    waypoint: Optional[str] = None


@app.post("/robots/{robot_id}/telemetry")
def robot_telemetry(robot_id: str, t: Telemetry):
    """Roaming telemetry ingestion. Used by the AWS IoT bridge and, as a
    fallback, directly by the robot over HTTP when AWS IoT is not configured."""
    return store.update_robot_telemetry(robot_id, t.model_dump())


@app.post("/robots/{robot_id}/blocks")
def robot_block(robot_id: str, req: CaptureRequest):
    """Robot-measured block ingestion over HTTP (fallback for the IoT blocks topic)."""
    return ingest_block(robot_id, {
        "block_id": req.block_id, "quarry_id": req.quarry_id, "source": "robot",
        "image_ref": req.image_ref, "granite_category": req.granite_category, "via": "http",
    })
