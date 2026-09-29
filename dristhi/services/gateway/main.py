"""
DRISHTI API Gateway (FastAPI).

Orchestrates the capture -> measure -> assess -> persist -> (OMEPS sync) ->
approval flow and serves the two UIs. This is the open-source, lightweight
gateway that runs with zero extra prerequisites (falls back to an in-memory
store if Postgres is down).

Robot data path (the robot captures and transmits; the portal calculates):
  robot --ECDH P-256 + HKDF-SHA256 session--> POST /robot-link/sessions
  robot --JWE compact (dir + A256GCM)-------> POST /robot-link/ingest  (or AWS IoT)
    secure_link   verify tag, header profile, freshness, jti + seq replay checks
    robot_schema  raw-only payload; derived/business fields are refused
    pipeline      vision -> seigniorage -> geofence -> block + calculation record
  The robot's receipt carries no calculated values.

A Spring Boot 3 / Java 21 skeleton lives in ./springboot for teams that prefer
the JVM stack; it mirrors the original REST contract only (the robot-link,
transmission, calculation and approval endpoints are FastAPI-only for now).

Security: bearer-token aware. In demo mode any 'demo.<user>.<role>' token is
accepted and its role parsed from the token. Wire real Keycloak JWT validation
in verify_token() for production.
"""
import os
from contextlib import asynccontextmanager
from typing import Literal, Optional

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from store import get_store
from iot_bridge import IoTBridge
from roam_engine import RoamEngine
from secure_link import DEVICE_ID_PATTERN, MAX_ENVELOPE_BYTES, PROTOCOL, LinkError, LinkRegistry
from robot_ingest import RobotIngest
from pipeline import ComputeServices, record_legacy_calculation, run_capture_pipeline

VISION_URL = os.getenv("VISION_URL", "http://localhost:8001")
SEIGNIORAGE_URL = os.getenv("SEIGNIORAGE_URL", "http://localhost:8002")
OMEPS_URL = os.getenv("OMEPS_URL", "http://localhost:8003")

store, store_kind = get_store()
link = LinkRegistry()
robot_ingest = RobotIngest(store, link)
compute = ComputeServices(VISION_URL, SEIGNIORAGE_URL)


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
        # MT basis + rate/category so both UIs render the Form-M assessment
        # identically (kept in sync with the seigniorage engine).
        "rate_per_m3_inr": a.get("rate_per_m3_inr"),
        "tonnage_mt": a.get("tonnage_mt"),
        "category_name": a.get("category_name"),
        "lat": data.get("lat"), "lon": data.get("lon"),
    }
    saved = store.upsert_block(block)
    store.add_audit(block_id, "measured", robot_id, {"method": m["measurement_method"], "via": data.get("via", "http")})
    store.add_audit(block_id, "classified", "seigniorage-engine", {"class": a["classification"]})
    record_legacy_calculation(
        store, block, m, a, source=source, via=data.get("via", "http"), actor=robot_id,
        inputs={"block_id": block_id, "quarry_id": quarry_id, "source": source,
                "image_ref": data.get("image_ref"), "granite_category": granite_category},
        geometry_formula="mock estimator: dimensions derived deterministically from the capture reference",
    )
    if source == "robot":
        store.increment_robot_blocks(robot_id)
    return saved


def _calculate_capture(capture_id: str):
    """Portal-side calculation for one raw robot capture (background task)."""
    try:
        run_capture_pipeline(store, compute, capture_id)
    except Exception as e:  # pragma: no cover
        print(f"[pipeline] capture {capture_id} failed: {e}")


def _on_iot_envelope(robot_id: str, payload: bytes):
    """AWS IoT path: same verifier + pipeline as HTTP. The topic's robot id
    (pinned to the thing name by the IoT policy) must match the envelope."""
    result = robot_ingest.receive(payload, transport="aws-iot", expected_device=robot_id)
    if result.capture_id:
        _calculate_capture(result.capture_id)


bridge = IoTBridge(on_envelope=_on_iot_envelope)

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
    return {"status": "ok", "store": store_kind, "iot": bridge.status(),
            "robot_link": {"protocol": PROTOCOL, "alg": "dir", "enc": "A256GCM"}}


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
    """Quick approve from the Blocks page. Same rules as POST /approvals/{id}."""
    return _decide(block_id, "approve", p, None)["block"]


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


# ---- Field capture (mobile PWA): image-to-volume estimate ------------------
class FieldEstimateRequest(BaseModel):
    """Marker-scaled pixel measurements captured in the field, plus optional
    metadata. Mirrors the reference demo's /api/field/estimate."""
    granite_type: str = "generic"
    marker_real_mm: float
    marker_pixels: float
    block_length_px: float
    block_width_px: float
    block_height_px: float
    perspective_correction: Optional[float] = None
    fill_factor: Optional[float] = None
    # Optional: persist the estimate as a pending block so it shows up in the
    # officer portal / audit trail. When absent, we only return the estimate.
    block_id: Optional[str] = None
    quarry_id: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


@app.post("/field/estimate")
def field_estimate(req: FieldEstimateRequest, p: Principal = Depends(verify_token)):
    """Recover pixel->metre scale from a reference marker, estimate L/W/H +
    volume via the vision service, run the seigniorage assessment, and return
    the full result. Optionally persists the block (measure->assess->persist)."""
    with httpx.Client(timeout=10) as client:
        m = client.post(f"{VISION_URL}/estimate-field", json={
            "marker_real_mm": req.marker_real_mm, "marker_pixels": req.marker_pixels,
            "block_length_px": req.block_length_px, "block_width_px": req.block_width_px,
            "block_height_px": req.block_height_px,
            "perspective_correction": req.perspective_correction, "fill_factor": req.fill_factor,
        }).json()
        a = client.post(f"{SEIGNIORAGE_URL}/assess", json={
            "volume_m3": m["volume_m3"], "granite_category": req.granite_type,
        }).json()

    result = {
        "method": m["measurement_method"],
        "metres_per_pixel": m["metres_per_pixel"],
        "length_m": m["length_m"], "width_m": m["width_m"], "height_m": m["height_m"],
        "volume_m3": m["volume_m3"], "confidence": m["confidence"],
        "classification": a["classification"], "granite_category": a["granite_category"],
        "category_name": a["category_name"], "rate_per_m3_inr": a["rate_per_m3_inr"],
        "tonnage_mt": a["tonnage_mt"], "seigniorage_fee_inr": a["seigniorage_fee_inr"],
        "threshold_m3": a["threshold_m3"],
    }

    # If a block id + quarry were supplied, persist so it appears in the portal.
    if req.block_id and req.quarry_id:
        actor = p.username if p.username != "anonymous" else "mobile"
        block = {
            "block_id": req.block_id, "quarry_id": req.quarry_id,
            "length_m": m["length_m"], "width_m": m["width_m"], "height_m": m["height_m"],
            "volume_m3": m["volume_m3"], "confidence": m["confidence"],
            "classification": a["classification"], "granite_category": a["granite_category"],
            "seigniorage_fee_inr": a["seigniorage_fee_inr"], "source": "mobile",
            "status": "pending", "measurement_method": m["measurement_method"],
            "rate_per_m3_inr": a["rate_per_m3_inr"], "tonnage_mt": a["tonnage_mt"],
            "category_name": a["category_name"], "lat": req.lat, "lon": req.lon,
        }
        saved = store.upsert_block(block)
        store.add_audit(req.block_id, "measured", actor,
                        {"method": m["measurement_method"], "via": "field-capture"})
        store.add_audit(req.block_id, "classified", "seigniorage-engine",
                        {"class": a["classification"]})
        record_legacy_calculation(
            store, block, m, a, source="mobile", via="field-capture", actor=actor,
            inputs={"marker_real_mm": req.marker_real_mm, "marker_pixels": req.marker_pixels,
                    "block_length_px": req.block_length_px, "block_width_px": req.block_width_px,
                    "block_height_px": req.block_height_px, "granite_type": req.granite_type,
                    "lat": req.lat, "lon": req.lon},
            geometry_formula="m/px = marker mm / 1000 / marker px · L/W/H = px × m/px × perspective · V = L × W × H × fill",
        )
        result["persisted"] = True
        result["block"] = saved
    else:
        result["persisted"] = False
    return result


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


# ---- Audit & traceability (requirement 5) ----
@app.get("/blocks/{block_id}/audit")
def block_audit(block_id: str, _: Principal = Depends(verify_token)):
    """Full lifecycle trail for one block: measurement -> classification ->
    OMEPS cross-validation -> approval/flag -> dispatch. Ordered newest-first."""
    if not store.get_block(block_id):
        raise HTTPException(404, "block not found")
    return store.list_audit(block_id)


@app.get("/audit")
def audit_feed(limit: int = 100, _: Principal = Depends(verify_token)):
    """Department-wide audit feed across all blocks (newest first)."""
    return store.list_audit(None, max(1, min(limit, 500)))


# ---- Analytics ----
@app.get("/analytics/summary")
def analytics(_: Principal = Depends(verify_token)):
    blocks = store.list_blocks()
    return {
        "total": len(blocks),
        "approved": sum(1 for b in blocks if b["status"] == "approved"),
        "pending": sum(1 for b in blocks if b["status"] == "pending"),
        "anomalies": sum(1 for b in blocks if b["status"] == "flagged"),
        "revenue_inr": round(sum(b.get("seigniorage_fee_inr") or 0 for b in blocks), 2),
        "total_volume_m3": round(sum(b.get("volume_m3") or 0 for b in blocks), 2),
        "total_tonnage_mt": round(sum(b.get("tonnage_mt") or 0 for b in blocks), 3),
        "above_gangsaw": sum(1 for b in blocks if b.get("classification") == "above_gangsaw"),
        "below_gangsaw": sum(1 for b in blocks if b.get("classification") == "below_gangsaw"),
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
    # Mark surveying, but don't let a transient store hiccup block the survey —
    # the roam engine streams telemetry that will set the status regardless.
    try:
        updated = store.set_robot_status(robot_id, "surveying")
        if updated:
            robot = updated
    except Exception as e:  # pragma: no cover
        print(f"[survey] set_robot_status failed (continuing): {e}")
    roam.start(robot_id, quarry_id=home_id, home_lat=q["lat"], home_lon=q["lon"],
               blocks=max(1, min(blocks, 30)), step_sec=max(0.05, min(step_sec, 5.0)),
               battery=float(battery) if battery is not None else 100.0)
    try:
        store.add_audit(robot_id, "survey_started", p.username, {"blocks": blocks, "quarry": home_id})
    except Exception:  # pragma: no cover
        pass
    return robot


@app.post("/robots/{robot_id}/survey/stop")
def stop_survey(robot_id: str, p: Principal = Depends(require_role("robot-operator", "admin"))):
    """Stop the survey: signal the roam engine to finish and return to dock."""
    if not store.set_robot_status(robot_id, "idle"):
        raise HTTPException(404, "robot not found")
    roam.stop(robot_id)
    store.add_audit(robot_id, "survey_stopped", p.username, {})
    return store.set_robot_status(robot_id, "idle")


# ---- Removed: unauthenticated plaintext robot ingestion ---------------------
_LEGACY_ROBOT_GONE = (
    "Plaintext robot ingestion was removed. Robots transmit raw captures over the "
    "secure robot link: POST /robot-link/sessions, then POST /robot-link/ingest "
    "(JWE compact, Content-Type: application/jose). See robot/drishti_link.py."
)


@app.post("/robots/{robot_id}/telemetry")
def robot_telemetry_removed(robot_id: str):
    raise HTTPException(410, _LEGACY_ROBOT_GONE)


@app.post("/robots/{robot_id}/blocks")
def robot_block_removed(robot_id: str):
    raise HTTPException(410, _LEGACY_ROBOT_GONE)


# ---- Secure robot link (robot -> portal) -----------------------------------
class LinkSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(pattern=DEVICE_ID_PATTERN)
    epk: dict  # robot's ephemeral ECDH P-256 public key (JWK)


@app.post("/robot-link/sessions")
def open_link_session(req: LinkSessionRequest, p: Principal = Depends(require_role("robot-operator"))):
    """Open a robot-link session via ephemeral ECDH key agreement. Requires a
    robot-operator (or admin) token and a registered device. Returns the
    gateway's ephemeral public key + HKDF salt; never a key."""
    if not store.get_robot(req.device_id):
        raise HTTPException(404, "unknown device")
    try:
        return link.open_session(req.device_id, req.epk, p.username)
    except LinkError as e:
        raise HTTPException(400, e.public)


@app.get("/robot-link/sessions")
def list_link_sessions(_: Principal = Depends(require_role("operator", "officer", "robot-operator"))):
    """Session metadata for the Transmission page (no key material)."""
    return link.list_sessions()


@app.delete("/robot-link/sessions/{kid}")
def revoke_link_session(kid: str, p: Principal = Depends(require_role("robot-operator"))):
    s = link.get(kid)
    if not s:
        raise HTTPException(404, "session not found")
    if p.role != "admin" and s.principal != p.username:
        raise HTTPException(403, "only the operator who opened a session (or an admin) can revoke it")
    link.revoke(kid)
    return {"kid": kid, "state": "revoked"}


@app.post("/robot-link/ingest")
async def robot_link_ingest(request: Request, background: BackgroundTasks):
    """Receive one encrypted robot envelope. Authentication is the AES-GCM tag
    under a live session key (no bearer token needed on this hop). The
    response is a receipt only; calculations run afterwards, portal-side."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype != "application/jose":
        return JSONResponse({"status": "rejected", "detail": "Content-Type must be application/jose"}, 415)
    declared = request.headers.get("content-length") or ""
    if declared.isdigit() and int(declared) > MAX_ENVELOPE_BYTES:
        return JSONResponse({"status": "rejected", "detail": "envelope too large"}, 413)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_ENVELOPE_BYTES:
            return JSONResponse({"status": "rejected", "detail": "envelope too large"}, 413)

    result = await run_in_threadpool(robot_ingest.receive, bytes(body), "http")
    if result.capture_id:
        background.add_task(_calculate_capture, result.capture_id)
    return JSONResponse(result.body, status_code=result.status_code, background=background)


# ---- Data transmission log --------------------------------------------------
@app.get("/transmissions")
def list_transmissions(limit: int = 100, _: Principal = Depends(require_role("operator", "officer"))):
    """Every envelope received: accepted, duplicate or rejected (with reason)."""
    return store.list_transmissions(max(1, min(limit, 500)))


# ---- Calculations (portal-side) ---------------------------------------------
@app.get("/calculations")
def list_calculations(limit: int = 100, _: Principal = Depends(require_role("operator", "officer"))):
    return store.list_calculations(max(1, min(limit, 500)))


@app.get("/calculations/{calc_id}")
def get_calculation(calc_id: str, _: Principal = Depends(require_role("operator", "officer"))):
    c = store.get_calculation(calc_id)
    if not c:
        raise HTTPException(404, "calculation not found")
    return c


@app.post("/calculations/{calc_id}/retry")
def retry_calculation(calc_id: str, background: BackgroundTasks,
                      p: Principal = Depends(require_role("officer"))):
    """Re-run a robot capture's calculation (e.g. vision service was down)."""
    c = store.get_calculation(calc_id)
    if not c:
        raise HTTPException(404, "calculation not found")
    if not c.get("capture_id"):
        raise HTTPException(409, "only robot-link captures can be re-run")
    if c.get("status") == "completed":
        raise HTTPException(409, "calculation already completed")
    background.add_task(_calculate_capture, c["capture_id"])
    return {"calc_id": calc_id, "status": "retrying", "requested_by": p.username}


# ---- Approvals ---------------------------------------------------------------
_DECIDABLE = ("pending", "flagged")


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]
    note: Optional[str] = Field(default=None, max_length=500)


def _decide(block_id: str, decision: str, p: Principal, note: Optional[str]) -> dict:
    b = store.get_block(block_id)
    if not b:
        raise HTTPException(404, "block not found")
    if b["status"] not in _DECIDABLE:
        raise HTTPException(409, f"block is already {b['status']}")
    note = (note or "").strip() or None
    calc = store.get_calculation_for_block(block_id)
    warnings = (calc or {}).get("warnings") or []
    if decision == "reject" and not note:
        raise HTTPException(422, "A reason is required to reject a block.")
    if decision == "approve" and (warnings or b["status"] == "flagged") and not note:
        raise HTTPException(422, "This block has calculation warnings or an OMEPS flag; "
                                 "add a justification note to approve it.")
    status = "approved" if decision == "approve" else "rejected"
    updated = store.set_status_if(block_id, status, _DECIDABLE)
    if not updated:  # someone else decided it first
        raise HTTPException(409, "block was decided concurrently")
    etp = store.next_e_transit_pass_no() if status == "approved" else None
    rec = store.add_approval({
        "block_id": block_id, "decision": status, "actor": p.username, "role": p.role, "note": note,
        "e_transit_pass_no": etp,
        "total_payable_inr": ((calc or {}).get("outputs") or {}).get("total_payable_inr"),
    })
    store.add_audit(block_id, status, p.username,
                    {k: v for k, v in {"note": note, "e_transit_pass_no": etp}.items() if v})
    return {**rec, "block": updated}


@app.get("/approvals/queue")
def approval_queue(_: Principal = Depends(require_role("officer"))):
    """Blocks awaiting a decision, with their portal-side calculation and the
    latest OMEPS cross-validation result."""
    calcs: dict = {}
    for c in reversed(store.list_calculations(1000)):  # oldest -> newest, newest wins
        if c.get("block_id"):
            calcs[c["block_id"]] = c
    omeps = store.latest_audit_by_type("omeps_synced")
    items = [{"block": b, "calculation": calcs.get(b["block_id"]),
              "omeps": (omeps.get(b["block_id"]) or {}).get("detail")}
             for b in store.list_blocks() if b.get("status") in _DECIDABLE]
    items.sort(key=lambda i: str((i["calculation"] or {}).get("created_at") or ""), reverse=True)
    return items


@app.get("/approvals")
def approval_history(limit: int = 100, _: Principal = Depends(require_role("officer"))):
    return store.list_approvals(max(1, min(limit, 500)))


@app.post("/approvals/{block_id}")
def decide(block_id: str, req: DecisionRequest, p: Principal = Depends(require_role("officer"))):
    """Approve (issues an e-transit pass number) or reject a block."""
    return _decide(block_id, req.decision, p, req.note)
