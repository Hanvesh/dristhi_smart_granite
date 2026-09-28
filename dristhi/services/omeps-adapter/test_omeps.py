from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_sync_no_anomaly():
    # 6.4 MT / 2.7 = 2.37 m3 vs AI 2.28 -> ~4% divergence, no anomaly
    r = client.post("/sync", json={"block_id": "B1", "ai_volume_m3": 2.28, "weighbridge_weight_mt": 6.4}).json()
    assert r["synced"] is True
    assert r["anomaly"] is False


def test_sync_anomaly():
    # AI says 10 m3 but weighbridge implies ~2.37 -> big divergence
    r = client.post("/sync", json={"block_id": "B2", "ai_volume_m3": 10.0, "weighbridge_weight_mt": 6.4}).json()
    assert r["anomaly"] is True
