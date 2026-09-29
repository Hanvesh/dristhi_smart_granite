"""End-to-end API tests: robot transmits raw data, the portal calculates.

The real vision and seigniorage FastAPI apps are loaded in-process, so the
numbers asserted here come from the actual calculation services.
"""
import importlib.util
import os
import sys
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from drishti_link import RobotLink
from pipeline import ComputeServices

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ROBOT_TOKEN = "demo.robotop.robot-operator"
OFFICER = {"Authorization": "Bearer demo.officer.officer"}
OPERATOR = {"Authorization": "Bearer demo.operator.operator"}


def _load_service(name: str, folder: str):
    path = os.path.join(ROOT, "services", folder)
    if path not in sys.path:
        sys.path.append(path)  # append: gateway's own `main` must keep precedence
    spec = importlib.util.spec_from_file_location(name, os.path.join(path, "main.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


VISION = TestClient(_load_service("vision_service_main", "vision").app)
SEIGNIORAGE = TestClient(_load_service("seigniorage_service_main", "seigniorage").app)


class InProcessServices(ComputeServices):
    def __init__(self):
        super().__init__("http://vision", "http://seigniorage")
        self.down = False

    def _post(self, url, payload):
        if self.down:
            raise httpx.ConnectError("vision service unreachable")
        client = VISION if url.startswith("http://vision/") else SEIGNIORAGE
        path = "/" + url.split("/", 3)[3]  # "http://vision/measure/lidar" -> "/measure/lidar"
        r = client.post(path, json=payload)
        r.raise_for_status()
        return r.json()


@pytest.fixture()
def api(monkeypatch):
    services = InProcessServices()
    monkeypatch.setattr(main, "compute", services)
    client = TestClient(main.app)

    def http(url, body, headers):
        r = client.post(url, content=body, headers=headers)
        return r.status_code, (r.json() if r.content else {})

    robot = RobotLink("", "DRISHTI-BOT-01", ROBOT_TOKEN, http=http)
    return client, robot, services


def raw_capture(**over):
    cap = {
        "schema": "drishti.robot.capture/v1",
        "capture_id": str(uuid.uuid4()),
        "quarry_id": "APQRY-0023",
        "block_ref": f"QRY-0023-T{uuid.uuid4().hex[:6].upper()}",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "sensor": {
            "lidar": {"extent_x_m": 1.2, "extent_y_m": 2.6, "extent_z_m": 1.1, "point_count": 86000,
                      "scan_ms": 1800, "sensor": "sim-lidar-360"},
            "camera": {"frame_ref": "frames/test.jpg", "frame_sha256": "a" * 64, "width_px": 1920, "height_px": 1080},
            "gnss": {"lat": 15.5812, "lon": 79.8623, "accuracy_m": 0.03, "fix": "RTK_FIXED"},
        },
        "robot": {"battery_percent": 88, "status": "surveying", "firmware": "drishti-rover-sim/2.0"},
    }
    cap.update(over)
    return cap


def _calc(client, calc_id):
    r = client.get(f"/calculations/{calc_id}", headers=OPERATOR)
    assert r.status_code == 200, r.text
    return r.json()


def test_capture_is_calculated_portal_side_and_receipt_has_no_business_data(api):
    client, robot, _ = api
    cap = raw_capture()
    receipt = robot.send("capture", cap)
    assert receipt["status"] == "accepted"
    assert set(receipt) == {"status", "receipt_id", "capture_id", "seq", "kid", "received_at"}

    calc = _calc(client, cap["capture_id"])
    assert calc["status"] == "completed" and calc["warnings"] == []
    out = calc["outputs"]
    # Vision: L = max(1.2, 2.6), W = 1.2, H = 1.1, V = 2.6 * 1.2 * 1.1 * 0.97
    assert (out["length_m"], out["width_m"], out["height_m"]) == (2.6, 1.2, 1.1)
    assert out["volume_m3"] == 3.329
    # Seigniorage (APQRY-0023 -> black_galaxy, above gangsaw -> 2000 * 1.25)
    assert out["classification"] == "above_gangsaw"
    assert out["seigniorage_fee_inr"] == round(3.329 * 2500, 2)
    assert (out["dmf_inr"], out["nmet_inr"], out["total_payable_inr"]) == (832.25, 166.45, 9321.2)
    steps = [s["step"] for s in calc["steps"]]
    assert steps == ["raw_input", "geometry", "classification", "seigniorage", "levies", "tonnage", "geofence"]
    assert calc["steps"][-1]["values"]["inside"] is True

    block = client.get(f"/blocks/{cap['block_ref']}").json()
    assert (block["status"], block["source"], block["volume_m3"]) == ("pending", "robot", 3.329)
    events = {e["event_type"] for e in client.get(f"/blocks/{cap['block_ref']}/audit").json()}
    assert {"transmitted", "measured", "classified"} <= events

    tx = next(t for t in client.get("/transmissions", headers=OPERATOR).json() if t["capture_id"] == cap["capture_id"])
    assert tx["status"] == "accepted" and tx["authenticated"] is True
    assert tx["payload"]["sensor"]["lidar"]["point_count"] == 86000
    assert tx["block_id"] == cap["block_ref"] and len(tx["payload_sha256"]) == 64


@pytest.mark.parametrize("smuggle", [
    {"seigniorage_fee_inr": 1.0},
    {"classification": "below_gangsaw"},
    {"sensor": {"lidar": {"extent_x_m": 1, "extent_y_m": 1, "extent_z_m": 1, "point_count": 1,
                          "scan_ms": 1, "sensor": "x", "volume_m3": 99.0}}},
])
def test_robot_cannot_smuggle_derived_or_business_values(api, smuggle):
    client, robot, _ = api
    cap = raw_capture(**smuggle)
    status, body = robot.send_envelope(robot.seal("capture", cap))
    assert status == 422 and body["status"] == "rejected"
    tx = client.get("/transmissions", headers=OPERATOR).json()[0]
    assert tx["status"] == "rejected" and tx["reason"].startswith("schema violation")
    assert client.get(f"/calculations/{cap['capture_id']}", headers=OPERATOR).status_code == 404


def test_retransmitted_capture_is_acknowledged_but_not_reprocessed(api):
    client, robot, _ = api
    cap = raw_capture()
    assert robot.send("capture", cap)["status"] == "accepted"
    again = robot.send("capture", cap)  # new envelope (new jti/seq), same capture_id
    assert again["status"] == "duplicate"
    blocks = [b for b in client.get("/blocks").json() if b["block_id"].startswith(cap["block_ref"])]
    assert len(blocks) == 1


def test_unknown_quarry_is_rejected(api):
    _, robot, _ = api
    status, body = robot.send_envelope(robot.seal("capture", raw_capture(quarry_id="APQRY-9999")))
    assert status == 422 and body["detail"] == "unknown quarry"


def test_ingest_requires_jose_content_type_and_bounded_size(api):
    client, _, _ = api
    assert client.post("/robot-link/ingest", content=b"x", headers={"Content-Type": "text/plain"}).status_code == 415
    big = b"a" * (64 * 1024 + 1)
    assert client.post("/robot-link/ingest", content=big, headers={"Content-Type": "application/jose"}).status_code == 413
    r = client.post("/robot-link/ingest", content=b"not-a-jwe", headers={"Content-Type": "application/jose"})
    assert r.status_code == 400 and r.json() == {"status": "rejected", "detail": "message rejected"}


def test_session_opening_requires_robot_operator_and_known_device(api):
    client, robot, _ = api
    epk = {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"}
    body = {"device_id": "DRISHTI-BOT-01", "epk": epk}
    assert client.post("/robot-link/sessions", json=body).status_code == 403
    assert client.post("/robot-link/sessions", json=body, headers=OFFICER).status_code == 403
    unknown = {"device_id": "DRISHTI-BOT-99", "epk": epk}
    assert client.post("/robot-link/sessions", json=unknown,
                       headers={"Authorization": f"Bearer {ROBOT_TOKEN}"}).status_code == 404
    kid = robot.open_session()["kid"]
    sessions = client.get("/robot-link/sessions", headers=OPERATOR).json()
    assert any(s["kid"] == kid and s["state"] == "active" for s in sessions)


def test_portal_pages_require_the_right_roles(api):
    client, _, _ = api
    for path in ("/transmissions", "/calculations", "/robot-link/sessions"):
        assert client.get(path).status_code == 403
        assert client.get(path, headers=OPERATOR).status_code == 200
    assert client.get("/approvals/queue", headers=OPERATOR).status_code == 403
    assert client.get("/approvals/queue", headers=OFFICER).status_code == 200
    assert client.post("/approvals/QRY-X", json={"decision": "approve"}, headers=OPERATOR).status_code == 403


def test_failed_calculation_is_recorded_and_can_be_retried(api):
    client, robot, services = api
    services.down = True
    cap = raw_capture()
    assert robot.send("capture", cap)["status"] == "accepted"
    failed = _calc(client, cap["capture_id"])
    assert failed["status"] == "failed" and "unreachable" in failed["error"]
    services.down = False
    assert client.post(f"/calculations/{cap['capture_id']}/retry", headers=OPERATOR).status_code == 403
    assert client.post(f"/calculations/{cap['capture_id']}/retry", headers=OFFICER).status_code == 200
    assert _calc(client, cap["capture_id"])["status"] == "completed"


def test_approval_issues_an_e_transit_pass_and_is_final(api):
    client, robot, _ = api
    cap = raw_capture()
    robot.send("capture", cap)
    block_id = cap["block_ref"]
    queue = client.get("/approvals/queue", headers=OFFICER).json()
    item = next(i for i in queue if i["block"]["block_id"] == block_id)
    assert item["calculation"]["outputs"]["total_payable_inr"] == 9321.2

    assert client.post(f"/approvals/{block_id}", json={"decision": "reject"}, headers=OFFICER).status_code == 422
    r = client.post(f"/approvals/{block_id}", json={"decision": "approve"}, headers=OFFICER)
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["decision"] == "approved" and rec["e_transit_pass_no"].startswith("ETP-AP-")
    assert rec["block"]["status"] == "approved" and rec["total_payable_inr"] == 9321.2
    assert client.post(f"/approvals/{block_id}", json={"decision": "approve"}, headers=OFFICER).status_code == 409
    history = client.get("/approvals", headers=OFFICER).json()
    assert history[0]["block_id"] == block_id
    events = {e["event_type"] for e in client.get(f"/blocks/{block_id}/audit").json()}
    assert "approved" in events


def test_capture_outside_the_concession_needs_a_justified_approval(api):
    client, robot, _ = api
    cap = raw_capture()
    cap["sensor"]["gnss"] = {"lat": 15.6100, "lon": 79.8620, "accuracy_m": 0.03, "fix": "RTK_FIXED"}  # ~3.2 km north
    robot.send("capture", cap)
    calc = _calc(client, cap["capture_id"])
    assert [w["code"] for w in calc["warnings"]] == ["gnss_outside_concession"]
    block_id = cap["block_ref"]
    assert client.post(f"/approvals/{block_id}", json={"decision": "approve"}, headers=OFFICER).status_code == 422
    r = client.post(f"/approvals/{block_id}", json={"decision": "approve", "note": "Stockpile moved; verified on site."},
                    headers=OFFICER)
    assert r.status_code == 200


def test_legacy_quick_approve_uses_the_same_rules(api):
    client, robot, _ = api
    cap = raw_capture()
    robot.send("capture", cap)
    r = client.post(f"/blocks/{cap['block_ref']}/approve", headers=OFFICER)
    assert r.status_code == 200 and r.json()["status"] == "approved"


def test_telemetry_envelope_updates_the_robot(api):
    client, robot, _ = api
    robot.send("telemetry", {"schema": "drishti.robot.telemetry/v1", "status": "surveying",
                             "battery_percent": 63, "waypoint": "-> QRY-0023-801"})
    bot = next(r for r in client.get("/robots").json() if r["robot_id"] == "DRISHTI-BOT-01")
    assert bot["battery_percent"] == 63 and bot["status"] == "surveying"


def test_plaintext_robot_endpoints_are_gone(api):
    client, _, _ = api
    assert client.post("/robots/DRISHTI-BOT-01/blocks", json={"block_id": "X", "quarry_id": "APQRY-0023"}).status_code == 410
    assert client.post("/robots/DRISHTI-BOT-01/telemetry", json={"battery_percent": 1}).status_code == 410
