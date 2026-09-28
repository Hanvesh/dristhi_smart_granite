"""DRISHTI Seigniorage Rules Engine (FastAPI)."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from rules import assess, GANGSAW_THRESHOLD_M3, GRANITE_RATES

app = FastAPI(title="DRISHTI Seigniorage Engine", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class AssessRequest(BaseModel):
    volume_m3: float
    granite_category: str = "generic"


class AssessResponse(BaseModel):
    classification: str
    granite_category: str
    seigniorage_fee_inr: float


@app.get("/health")
def health():
    return {"status": "ok", "gangsaw_threshold_m3": GANGSAW_THRESHOLD_M3, "categories": list(GRANITE_RATES)}


@app.post("/assess", response_model=AssessResponse)
def do_assess(req: AssessRequest):
    a = assess(req.volume_m3, req.granite_category)
    return AssessResponse(**a.__dict__)
