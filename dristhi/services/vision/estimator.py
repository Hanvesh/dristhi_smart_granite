"""
Granite dimension estimator.

Two implementations behind one interface:

- MockEstimator (default): deterministic, weights-free. Produces plausible
  dimensions from an image hash / block_id so the whole pipeline runs without
  a GPU or model downloads. Used for demos and CI.

- RealEstimator (stub): the place to wire YOLOv11 (Ultralytics) for
  detection/segmentation + Depth Anything V2 for monocular depth + OpenCV for
  geometric dimension extraction, or the OAK-D stereo point-cloud path for the
  robot. Enable by setting DRISHTI_VISION_BACKEND=real and installing the
  optional requirements.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass


@dataclass
class Measurement:
    length_m: float
    width_m: float
    height_m: float
    volume_m3: float
    confidence: float
    method: str


class MockEstimator:
    """Deterministic pseudo-measurement derived from a seed string."""

    method = "mock_monocular"

    def estimate(self, seed: str, source: str = "mobile") -> Measurement:
        h = hashlib.sha256(seed.encode()).digest()
        # Map hash bytes into realistic granite block ranges.
        length = round(1.5 + (h[0] / 255) * 2.0, 2)   # 1.5 - 3.5 m
        width = round(0.8 + (h[1] / 255) * 1.0, 2)    # 0.8 - 1.8 m
        height = round(0.6 + (h[2] / 255) * 0.9, 2)   # 0.6 - 1.5 m
        volume = round(length * width * height, 2)
        # Robot stereo path is more confident than mobile monocular.
        base = 0.90 if source == "robot" else 0.80
        confidence = round(min(0.99, base + (h[3] / 255) * 0.1), 2)
        method = "robot_stereo_pointcloud" if source == "robot" else "mobile_monocular"
        return Measurement(length, width, height, volume, confidence, method)


class RealEstimator:  # pragma: no cover - requires model weights
    """Stub for production inference. See module docstring for the pipeline."""

    method = "real"

    def estimate(self, seed: str, source: str = "mobile") -> Measurement:
        raise NotImplementedError(
            "RealEstimator requires YOLOv11 + Depth Anything V2 (mobile) or "
            "OAK-D stereo point cloud (robot). Install optional requirements and "
            "implement inference here."
        )


def get_estimator():
    backend = os.getenv("DRISHTI_VISION_BACKEND", "mock").lower()
    return RealEstimator() if backend == "real" else MockEstimator()
