"""
DRISHTI OMEPS 2.0 Integration Adapter (FastAPI).

MOCK: OMEPS 2.0 is a government system whose real API spec/credentials are not
available here. This adapter simulates the cross-validation contract:
  - accept an AI-computed block volume
  - compare against a (mock) weighbridge-derived volume
  - flag anomalies beyond a tolerance
  - return a sync acknowledgement

Replace the mock internals with the real OMEPS REST client when the spec is
provided. The external contract (endpoints below) can stay the same.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="DRISHTI OMEPS 2.0 Adapter", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Granite density ~ 2.7 MT/m3; used to derive volume from weighbridge weight.
GRANITE_DENSITY_MT_PER_M3 = 2.7
ANOMALY_TOLERANCE = 0.15  # 15% divergence flags an anomaly


class SyncRequest(BaseModel):
    block_id: str
    ai_volume_m3: float
    weighbridge_weight_mt: Optional[float] = None
    dispatch_ref: Optional[str] = None


class SyncResponse(BaseModel):
    block_id: str
    synced: bool
    weighbridge_volume_m3: Optional[float]
    divergence: Optional[float]
    anomaly: bool
    message: str


@app.get("/health")
def health():
    return {"status": "ok", "mode": "mock"}


@app.post("/sync", response_model=SyncResponse)
def sync(req: SyncRequest):
    wb_volume = None
    divergence = None
    anomaly = False
    if req.weighbridge_weight_mt is not None:
        wb_volume = round(req.weighbridge_weight_mt / GRANITE_DENSITY_MT_PER_M3, 2)
        if wb_volume > 0:
            divergence = round(abs(req.ai_volume_m3 - wb_volume) / wb_volume, 3)
            anomaly = divergence > ANOMALY_TOLERANCE
    msg = "Anomaly: AI vs weighbridge divergence exceeds tolerance" if anomaly else "Synced to OMEPS 2.0 (mock)"
    return SyncResponse(
        block_id=req.block_id,
        synced=True,
        weighbridge_volume_m3=wb_volume,
        divergence=divergence,
        anomaly=anomaly,
        message=msg,
    )
