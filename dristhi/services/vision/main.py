"""
DRISHTI Vision Service (FastAPI).

Estimates granite block dimensions/volume from a capture. In the default mock
backend no model weights are required, so the full pipeline is runnable anywhere.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
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


class FieldEstimateRequest(BaseModel):
    """Marker-scale image-to-volume inputs from the mobile field-capture flow.
    The on-device CV step detects the reference marker + block edges and reports
    the pixel measurements; this service reconstructs the geometry."""
    marker_real_mm: float
    marker_pixels: float
    block_length_px: float
    block_width_px: float
    block_height_px: float
    perspective_correction: Optional[float] = None  # (0.5, 1.0], foreshortening
    fill_factor: Optional[float] = None              # irregular-face fill (0.8, 1.0]


class FieldEstimateResponse(BaseModel):
    length_m: float
    width_m: float
    height_m: float
    volume_m3: float
    confidence: float
    metres_per_pixel: float
    measurement_method: str


class LidarMeasureRequest(BaseModel):
    """Raw LiDAR capture transmitted by the robot: the extents of the segmented
    block's point cluster along the sensor axes (x/y horizontal, z vertical)
    and the number of points in that cluster. The robot reports what the
    sensor saw and nothing else; every derived number is computed here."""
    block_id: str = Field(min_length=1, max_length=64)
    extent_x_m: float = Field(gt=0, le=20)
    extent_y_m: float = Field(gt=0, le=20)
    extent_z_m: float = Field(gt=0, le=20)
    point_count: int = Field(ge=0, le=50_000_000)
    fill_factor: Optional[float] = None  # override for irregular faces, (0.8, 1.0]


class LidarMeasureResponse(BaseModel):
    block_id: str
    length_m: float
    width_m: float
    height_m: float
    volume_m3: float
    confidence: float
    fill_factor: float
    surface_area_m2: float
    point_density_per_m2: float
    measurement_method: str


# Rough-hewn quarry blocks never fill their bounding box completely; 0.97 is
# the same default the field (marker-scale) estimator uses.
LIDAR_FILL_FACTOR = 0.97
# Point density (pts/m2 of block surface) at which the scan is considered
# fully resolved for confidence purposes.
LIDAR_FULL_DENSITY_PER_M2 = 2500.0


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


@app.get("/health")
def health():
    return {"status": "ok", "backend": type(estimator).__name__}


@app.post("/estimate-field", response_model=FieldEstimateResponse)
def estimate_field(req: FieldEstimateRequest):
    """Recover a pixel->metre scale from a reference marker of known size, then
    apply it to the block's bounding-box pixels to estimate L/W/H and volume.
    Mirrors the reference demo's ImageVolumeService (aruco_marker_scale_v1)."""
    marker_mm = max(1e-6, req.marker_real_mm)
    marker_px = max(1e-6, req.marker_pixels)
    persp = _clamp(req.perspective_correction if req.perspective_correction is not None else 1.0, 0.5, 1.0)
    fill = _clamp(req.fill_factor if req.fill_factor is not None else 0.97, 0.80, 1.0)

    metres_per_pixel = (marker_mm / 1000.0) / marker_px
    length_m = round(max(0.0, req.block_length_px) * metres_per_pixel * persp, 3)
    width_m = round(max(0.0, req.block_width_px) * metres_per_pixel * persp, 3)
    height_m = round(max(0.0, req.block_height_px) * metres_per_pixel * persp, 3)
    volume_m3 = round(length_m * width_m * height_m * fill, 4)

    # Confidence heuristic: a larger marker relative to the block = better scale
    # accuracy; heavy perspective correction lowers it.
    scale_quality = _clamp(marker_px / max(req.block_length_px, 1.0) * 4.0, 0.0, 1.0)
    confidence = round(_clamp(0.78 + 0.18 * scale_quality - (1.0 - persp) * 0.3, 0.6, 0.98), 3)

    return FieldEstimateResponse(
        length_m=length_m, width_m=width_m, height_m=height_m, volume_m3=volume_m3,
        confidence=confidence, metres_per_pixel=round(metres_per_pixel, 6),
        measurement_method="aruco_marker_scale_v1",
    )


@app.post("/measure/lidar", response_model=LidarMeasureResponse)
def measure_lidar(req: LidarMeasureRequest):
    """Turn raw robot LiDAR extents into billable geometry.

    Length is the longer horizontal extent, width the shorter one, height the
    vertical extent. Volume = L x W x H x fill factor. Confidence scales with
    point density over the block's surface area.
    """
    length_m = round(max(req.extent_x_m, req.extent_y_m), 3)
    width_m = round(min(req.extent_x_m, req.extent_y_m), 3)
    height_m = round(req.extent_z_m, 3)
    fill = _clamp(req.fill_factor if req.fill_factor is not None else LIDAR_FILL_FACTOR, 0.80, 1.0)
    volume_m3 = round(length_m * width_m * height_m * fill, 3)

    area = 2.0 * (length_m * width_m + length_m * height_m + width_m * height_m)
    density = req.point_count / area if area > 0 else 0.0
    confidence = round(_clamp(0.70 + 0.29 * min(1.0, density / LIDAR_FULL_DENSITY_PER_M2), 0.6, 0.99), 3)

    return LidarMeasureResponse(
        block_id=req.block_id, length_m=length_m, width_m=width_m, height_m=height_m,
        volume_m3=volume_m3, confidence=confidence, fill_factor=fill,
        surface_area_m2=round(area, 3), point_density_per_m2=round(density, 1),
        measurement_method="robot_lidar_obb_v1",
    )


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
