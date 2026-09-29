"""
Portal-side calculation pipeline.

Every number the portal shows for a block is computed here or by the services
this module calls, never on the robot:

  raw robot capture -> vision  /measure/lidar  (L/W/H, volume, confidence)
                    -> seigniorage /assess      (class, fee, DMF/NMET, tonnage)
                    -> concession geofence      (GNSS fix vs quarry boundary)
                    -> block (pending approval) + calculation record + audit

Each run is stored as a calculation record with the inputs, every step (with
its formula and the engine that computed it), the outputs and any warnings,
so the Calculation page can show exactly how a fee was derived.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Optional

import httpx

from quarry_registry import geofence, get_quarry
from robot_schema import RawCapture

PIPELINE_VERSION = "gateway-pipeline/1"
LOW_CONFIDENCE = 0.80

_alloc_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ComputeServices:
    """HTTP client for the calculation services."""

    def __init__(self, vision_url: str, seigniorage_url: str, timeout: float = 10.0):
        self.vision_url = vision_url.rstrip("/")
        self.seigniorage_url = seigniorage_url.rstrip("/")
        self.timeout = timeout

    def _post(self, url: str, payload: dict) -> dict:
        with httpx.Client(timeout=self.timeout) as client:
            r = client.post(url, json=payload)
            r.raise_for_status()
            return r.json()

    def measure_lidar(self, block_id: str, lidar) -> dict:
        return self._post(f"{self.vision_url}/measure/lidar", {
            "block_id": block_id, "extent_x_m": lidar.extent_x_m, "extent_y_m": lidar.extent_y_m,
            "extent_z_m": lidar.extent_z_m, "point_count": lidar.point_count,
        })

    def assess(self, volume_m3: float, granite_category: str) -> dict:
        return self._post(f"{self.seigniorage_url}/assess",
                          {"volume_m3": volume_m3, "granite_category": granite_category})


# ---- record builders -------------------------------------------------------
def _assessment_steps(m: dict, a: dict) -> list[dict]:
    above = a["classification"] == "above_gangsaw"
    fee = a["seigniorage_fee_inr"]
    dmf, nmet = a.get("dmf_inr"), a.get("nmet_inr")
    return [
        {"step": "classification", "title": "Gangsaw classification", "engine": "seigniorage-engine",
         "formula": f"volume {m['volume_m3']} m³ {'>' if above else '≤'} threshold {a['threshold_m3']} m³",
         "values": {"volume_m3": m["volume_m3"], "threshold_m3": a["threshold_m3"],
                    "classification": a["classification"]}},
        {"step": "seigniorage", "title": "Base seigniorage", "engine": "seigniorage-engine",
         "formula": "fee = volume × base rate × above-gangsaw premium",
         "values": {"granite_category": a["granite_category"], "category_name": a["category_name"],
                    "base_rate_per_m3_inr": a.get("base_rate_per_m3_inr"),
                    "premium_multiplier": a.get("premium_multiplier"),
                    "rate_per_m3_inr": a["rate_per_m3_inr"], "seigniorage_fee_inr": fee}},
        {"step": "levies", "title": "Form-M levies", "engine": "seigniorage-engine",
         "formula": "DMF = fee × DMF rate · NMET = fee × NMET rate · total = fee + DMF + NMET",
         "values": {"dmf_rate": round(dmf / fee, 4) if fee and dmf is not None else None, "dmf_inr": dmf,
                    "nmet_rate": round(nmet / fee, 4) if fee and nmet is not None else None, "nmet_inr": nmet,
                    "total_payable_inr": a.get("total_payable_inr")}},
        {"step": "tonnage", "title": "Metric-tonne basis", "engine": "seigniorage-engine",
         "formula": "tonnage = volume × density",
         "values": {"density_mt_per_m3": a.get("density_mt_per_m3"), "tonnage_mt": a["tonnage_mt"]}},
    ]


def _outputs(block_id: str, m: dict, a: dict) -> dict:
    return {
        "block_id": block_id, "length_m": m["length_m"], "width_m": m["width_m"], "height_m": m["height_m"],
        "volume_m3": m["volume_m3"], "confidence": m["confidence"],
        "classification": a["classification"], "granite_category": a["granite_category"],
        "category_name": a["category_name"], "rate_per_m3_inr": a["rate_per_m3_inr"],
        "seigniorage_fee_inr": a["seigniorage_fee_inr"], "dmf_inr": a.get("dmf_inr"),
        "nmet_inr": a.get("nmet_inr"), "total_payable_inr": a.get("total_payable_inr"),
        "tonnage_mt": a["tonnage_mt"],
    }


def _block(block_id: str, quarry_id: str, source: str, m: dict, a: dict,
           lat: Optional[float], lon: Optional[float]) -> dict:
    return {
        "block_id": block_id, "quarry_id": quarry_id,
        "length_m": m["length_m"], "width_m": m["width_m"], "height_m": m["height_m"],
        "volume_m3": m["volume_m3"], "confidence": m["confidence"],
        "classification": a["classification"], "granite_category": a["granite_category"],
        "seigniorage_fee_inr": a["seigniorage_fee_inr"], "source": source, "status": "pending",
        "measurement_method": m["measurement_method"], "rate_per_m3_inr": a.get("rate_per_m3_inr"),
        "tonnage_mt": a.get("tonnage_mt"), "category_name": a.get("category_name"),
        "lat": lat, "lon": lon,
    }


def _warnings(m: dict, fence: Optional[dict], gnss_expected: bool, has_gnss: bool) -> list[dict]:
    out = []
    if gnss_expected and not has_gnss:
        out.append({"code": "gnss_missing", "message": "Capture has no GNSS fix; location could not be verified."})
    elif fence and fence.get("checked") and not fence.get("inside"):
        out.append({"code": "gnss_outside_concession",
                    "message": f"GNSS fix is outside the quarry concession "
                               f"({fence['distance_to_centre_m']} m from centre)."})
    if m["confidence"] < LOW_CONFIDENCE:
        out.append({"code": "low_confidence",
                    "message": f"Measurement confidence {m['confidence']:.2f} is below {LOW_CONFIDENCE:.2f}."})
    return out


# ---- robot captures ----------------------------------------------------------
def run_capture_pipeline(store, services: ComputeServices, capture_id: str) -> dict:
    """Calculate everything for one stored raw capture. Service failures are
    recorded as a failed calculation (retryable from the portal)."""
    cap = store.get_capture(capture_id)
    if not cap:
        raise KeyError(f"capture {capture_id} not found")
    raw = RawCapture.model_validate(cap["payload"])
    quarry = get_quarry(raw.quarry_id) or {}
    category = quarry.get("granite_category", "generic")
    lidar, gnss, camera = raw.sensor.lidar, raw.sensor.gnss, raw.sensor.camera
    device_id = cap["device_id"]

    raw_step = {
        "step": "raw_input", "title": "Raw capture from robot", "engine": f"robot {device_id}",
        "formula": "sensor readings as transmitted; nothing is derived on the robot",
        "values": {
            "extent_x_m": lidar.extent_x_m, "extent_y_m": lidar.extent_y_m, "extent_z_m": lidar.extent_z_m,
            "point_count": lidar.point_count, "scan_ms": lidar.scan_ms, "lidar_sensor": lidar.sensor,
            "gnss": gnss.model_dump() if gnss else None,
            "frame_sha256": camera.frame_sha256 if camera else None,
            "quarry_id": raw.quarry_id, "granite_category_from_registry": category,
        },
    }
    base = {
        "calc_id": capture_id, "capture_id": capture_id, "device_id": device_id,
        "quarry_id": raw.quarry_id, "source": "robot", "block_id": cap.get("block_id"),
        "engine": {"pipeline": PIPELINE_VERSION, "vision": "robot_lidar_obb_v1",
                   "seigniorage": "rules.py (placeholder slabs)"},
        "created_at": cap.get("received_at") or _now_iso(),
    }
    store.upsert_calculation({**base, "status": "running", "steps": [raw_step], "outputs": {},
                              "warnings": [], "error": None, "updated_at": _now_iso()})
    try:
        m = services.measure_lidar(raw.block_ref, lidar)
        a = services.assess(m["volume_m3"], category)
    except Exception as e:
        failed = {**base, "status": "failed", "steps": [raw_step], "outputs": {}, "warnings": [],
                  "error": f"{type(e).__name__}: {e}"[:300], "updated_at": _now_iso()}
        store.upsert_calculation(failed)
        return failed

    fence = geofence(quarry, gnss.lat if gnss else None, gnss.lon if gnss else None)
    warnings = _warnings(m, fence, gnss_expected=True, has_gnss=gnss is not None)

    with _alloc_lock:  # block ids are allocated + inserted atomically
        block_id = cap.get("block_id") or store.allocate_block_id(raw.block_ref)
        store.upsert_block(_block(block_id, raw.quarry_id, "robot", m, a,
                                  gnss.lat if gnss else None, gnss.lon if gnss else None))
        store.set_capture_block(capture_id, block_id)

    steps = [raw_step,
             {"step": "geometry", "title": "Dimensions & volume", "engine": f"vision-service ({m['measurement_method']})",
              "formula": "L = max(x, y) · W = min(x, y) · H = z · V = L × W × H × fill",
              "values": {k: m.get(k) for k in ("length_m", "width_m", "height_m", "fill_factor", "volume_m3",
                                               "surface_area_m2", "point_density_per_m2", "confidence")}}]
    steps += _assessment_steps(m, a)
    steps.append({"step": "geofence", "title": "Concession geofence", "engine": "portal-pipeline",
                  "formula": "GNSS fix must fall inside the quarry's rectangular concession", "values": fence})
    calc = {**base, "block_id": block_id, "status": "completed", "steps": steps,
            "outputs": _outputs(block_id, m, a), "warnings": warnings, "error": None, "updated_at": _now_iso()}
    store.upsert_calculation(calc)

    store.add_audit(block_id, "transmitted", device_id,
                    {"capture_id": capture_id, "msg_id": cap.get("msg_id"), "channel": "ECDH-P256/HKDF-SHA256/A256GCM"})
    store.add_audit(block_id, "measured", "vision-service",
                    {"method": m["measurement_method"], "confidence": m["confidence"]})
    store.add_audit(block_id, "classified", "seigniorage-engine",
                    {"class": a["classification"], "fee_inr": a["seigniorage_fee_inr"],
                     "total_payable_inr": a.get("total_payable_inr")})
    if warnings:
        store.add_audit(block_id, "calculation_warning", "portal-pipeline",
                        {"warnings": ", ".join(w["code"] for w in warnings)})
    store.increment_robot_blocks(device_id)
    return calc


# ---- other ingestion paths (portal capture, field estimate, roam engine) ----
def record_legacy_calculation(store, block: dict, m: dict, a: dict, source: str, via: str,
                              actor: str, inputs: dict, geometry_formula: str):
    """Keep the Calculation page complete for blocks that did not come in over
    the robot link. Best effort: never fails the ingestion itself."""
    now = _now_iso()
    steps = [
        {"step": "raw_input", "title": f"Capture ({via})", "engine": actor,
         "formula": "inputs as submitted", "values": inputs},
        {"step": "geometry", "title": "Dimensions & volume", "engine": f"vision-service ({m['measurement_method']})",
         "formula": geometry_formula,
         "values": {k: m.get(k) for k in ("length_m", "width_m", "height_m", "volume_m3", "confidence")}},
    ] + _assessment_steps(m, a)
    calc = {
        "calc_id": block["block_id"], "block_id": block["block_id"], "capture_id": None, "device_id": actor,
        "quarry_id": block.get("quarry_id"), "source": source, "status": "completed", "steps": steps,
        "outputs": _outputs(block["block_id"], m, a), "warnings": _warnings(m, None, False, False),
        "error": None, "engine": {"pipeline": PIPELINE_VERSION, "vision": m["measurement_method"],
                                  "seigniorage": "rules.py (placeholder slabs)"},
        "created_at": now, "updated_at": now,
    }
    try:
        store.upsert_calculation(calc)
    except Exception as e:  # pragma: no cover
        print(f"[pipeline] could not record calculation for {block['block_id']}: {e}")
