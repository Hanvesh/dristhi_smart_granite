"""
DRISHTI Vision Service (FastAPI).

Estimates granite block dimensions/volume from a capture. In the default mock
backend no model weights are required, so the full pipeline is runnable anywhere.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from estimator import get_estimator

app = FastAPI(title="DRISHTI Vision Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

estimator = get_estimator()


class MeasureRequest(BaseModel):
    block_id: str
    source: str = "mobile"            # mobile | robot
    image_ref: Optional[str] = None   # MinIO object key (optional in mock mode)


class MeasureResponse(BaseModel):
    block_id: str
    length_m: float
    width_m: float
    height_m: float
    volume_m3: float
    confidence: float
    measurement_method: str


@app.get("/health")
def health():
    return {"status": "ok", "backend": type(estimator).__name__}


@app.post("/measure", response_model=MeasureResponse)
def measure(req: MeasureRequest):
    seed = req.image_ref or req.block_id
    m = estimator.estimate(seed, req.source)
    return MeasureResponse(
        block_id=req.block_id,
        length_m=m.length_m,
        width_m=m.width_m,
        height_m=m.height_m,
        volume_m3=m.volume_m3,
        confidence=m.confidence,
        measurement_method=m.method,
    )
