"""
Schemas for what a robot is allowed to transmit (decrypted envelope payloads).

The robot is a sensor platform: it reports raw readings and its own state.
Every model forbids unknown fields, so a payload carrying derived or business
values (volume, classification, fees, tonnage, approvals...) is rejected at
the gateway boundary instead of being silently trusted. All of those values
are computed portal-side by pipeline.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

CAPTURE_SCHEMA = "drishti.robot.capture/v1"
TELEMETRY_SCHEMA = "drishti.robot.telemetry/v1"

_TOKEN = r"^[A-Za-z0-9._/+-]{1,64}$"
_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

RobotStatus = Literal["idle", "surveying", "returning", "charging"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LidarReading(_Strict):
    """Extents of the segmented block's point cluster along the sensor axes
    (x/y horizontal, z vertical), as reported by the LiDAR driver."""
    extent_x_m: float = Field(gt=0, le=20)
    extent_y_m: float = Field(gt=0, le=20)
    extent_z_m: float = Field(gt=0, le=20)
    point_count: int = Field(ge=0, le=50_000_000)
    scan_ms: int = Field(ge=0, le=600_000)
    sensor: str = Field(pattern=_TOKEN)


class CameraFrame(_Strict):
    """Reference to the RGB evidence frame (stored separately) plus its hash,
    so the evidence can be verified later without shipping the image here."""
    frame_ref: str = Field(pattern=r"^[A-Za-z0-9._/:-]{1,256}$")
    frame_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    width_px: int = Field(ge=1, le=20_000)
    height_px: int = Field(ge=1, le=20_000)


class GnssFix(_Strict):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy_m: float = Field(ge=0, le=1000)
    fix: Literal["RTK_FIXED", "RTK_FLOAT", "DGPS", "GPS", "NONE"]


class RobotState(_Strict):
    battery_percent: int = Field(ge=0, le=100)
    status: RobotStatus
    firmware: str = Field(pattern=_TOKEN)


class SensorBundle(_Strict):
    lidar: LidarReading
    camera: Optional[CameraFrame] = None
    gnss: Optional[GnssFix] = None


class RawCapture(_Strict):
    schema_id: Literal["drishti.robot.capture/v1"] = Field(alias="schema")
    capture_id: str = Field(pattern=_UUID)
    quarry_id: str = Field(pattern=r"^APQRY-[0-9]{4}$")
    block_ref: str = Field(pattern=r"^[A-Z0-9][A-Z0-9-]{2,47}$")
    captured_at: datetime
    sensor: SensorBundle
    robot: Optional[RobotState] = None

    @field_validator("captured_at")
    @classmethod
    def _captured_at_sane(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("captured_at must include a timezone")
        now = datetime.now(timezone.utc)
        if v > now + timedelta(minutes=5):
            raise ValueError("captured_at is in the future")
        if v < now - timedelta(days=30):
            raise ValueError("captured_at is older than 30 days")
        return v


class RawTelemetry(_Strict):
    schema_id: Literal["drishti.robot.telemetry/v1"] = Field(alias="schema")
    status: RobotStatus
    battery_percent: int = Field(ge=0, le=100)
    gnss: Optional[GnssFix] = None
    waypoint: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9 ._:>()/-]{0,64}$")
