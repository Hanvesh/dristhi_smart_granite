"""
Robot ingest: the single entry point for robot data (HTTP and AWS IoT).

receive() verifies and decrypts an envelope (secure_link), validates the
payload against the raw-only schemas (robot_schema), logs the transmission,
stores the raw capture, and returns the receipt the robot sees. The receipt
carries no calculated values; calculations run afterwards in pipeline.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Union

from pydantic import ValidationError

from quarry_registry import get_quarry
from robot_schema import CAPTURE_SCHEMA, TELEMETRY_SCHEMA, RawCapture, RawTelemetry
from secure_link import LinkError, LinkRegistry, OpenedMessage, peek_header


@dataclass
class IngestResult:
    status_code: int
    body: dict
    # Set only for a NEW capture that still needs the calculation pipeline.
    capture_id: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _schema_reason(err: ValidationError) -> str:
    first = err.errors()[0]
    loc = ".".join(str(p) for p in first.get("loc", ())) or "<root>"
    return f"schema violation at '{loc}': {first.get('msg')}"[:300]


class RobotIngest:
    def __init__(self, store, link: LinkRegistry):
        self.store = store
        self.link = link

    def receive(self, envelope: Union[bytes, str], transport: str,
                expected_device: Optional[str] = None) -> IngestResult:
        received_at = _now_iso()
        try:
            msg = self.link.open(envelope, expected_device=expected_device)
        except LinkError as e:
            claimed = peek_header(envelope)  # unauthenticated, for labelling only
            self._log(status="rejected", reason=e.reason, transport=transport, received_at=received_at,
                      size_bytes=len(envelope or b""), authenticated=False, header=claimed,
                      msg_id=claimed.get("jti"), device_id=claimed.get("dev"), kid=claimed.get("kid"),
                      seq=claimed.get("seq"), content_type=claimed.get("cty"))
            return IngestResult(e.status, {"status": "rejected", "detail": e.public})

        if msg.content_type == "capture":
            return self._capture(msg, transport, received_at)
        return self._telemetry(msg, transport, received_at)

    # ---- content types ---------------------------------------------------
    def _capture(self, msg: OpenedMessage, transport: str, received_at: str) -> IngestResult:
        try:
            cap = RawCapture.model_validate(msg.payload)
        except ValidationError as ve:
            self._log_msg(msg, "rejected", _schema_reason(ve), transport, received_at)
            return IngestResult(422, {"status": "rejected", "detail": f"payload does not match {CAPTURE_SCHEMA}"})
        if get_quarry(cap.quarry_id) is None:
            self._log_msg(msg, "rejected", f"unknown quarry {cap.quarry_id}", transport, received_at)
            return IngestResult(422, {"status": "rejected", "detail": "unknown quarry"})

        inserted = self.store.add_capture({
            "capture_id": cap.capture_id, "device_id": msg.device_id, "quarry_id": cap.quarry_id,
            "block_ref": cap.block_ref, "captured_at": cap.captured_at, "block_id": None,
            "payload": cap.model_dump(mode="json", by_alias=True), "msg_id": msg.jti,
            "received_at": received_at,
        })
        if not inserted:
            existing = self.store.get_capture(cap.capture_id) or {}
            if existing.get("device_id") != msg.device_id:
                self._log_msg(msg, "rejected", "capture_id already used by another device", transport, received_at)
                return IngestResult(409, {"status": "rejected", "detail": "capture_id conflict"})
            # Retransmission after a lost ACK: new jti/seq, same capture_id.
            self._log_msg(msg, "duplicate", "capture already received; not reprocessed",
                          transport, received_at, capture_id=cap.capture_id)
            return IngestResult(200, self._ack("duplicate", msg, cap.capture_id, received_at))

        self._log_msg(msg, "accepted", None, transport, received_at, capture_id=cap.capture_id)
        if cap.robot:  # the robot's raw state rides along with each capture
            self._update_robot(msg.device_id, cap.robot.status, cap.robot.battery_percent,
                               cap.sensor.gnss, f"captured {cap.block_ref}")
        return IngestResult(202, self._ack("accepted", msg, cap.capture_id, received_at),
                            capture_id=cap.capture_id)

    def _telemetry(self, msg: OpenedMessage, transport: str, received_at: str) -> IngestResult:
        try:
            t = RawTelemetry.model_validate(msg.payload)
        except ValidationError as ve:
            self._log_msg(msg, "rejected", _schema_reason(ve), transport, received_at)
            return IngestResult(422, {"status": "rejected", "detail": f"payload does not match {TELEMETRY_SCHEMA}"})
        self._update_robot(msg.device_id, t.status, t.battery_percent, t.gnss, t.waypoint)
        self._log_msg(msg, "accepted", None, transport, received_at)
        return IngestResult(202, self._ack("accepted", msg, None, received_at))

    # ---- helpers ---------------------------------------------------------
    @staticmethod
    def _ack(status: str, msg: OpenedMessage, capture_id: Optional[str], received_at: str) -> dict:
        return {"status": status, "receipt_id": msg.jti, "capture_id": capture_id,
                "seq": msg.seq, "kid": msg.kid, "received_at": received_at}

    def _update_robot(self, device_id, status, battery, gnss, waypoint):
        data = {"status": status, "battery_percent": battery, "waypoint": waypoint}
        if gnss is not None:
            data.update(lat=gnss.lat, lon=gnss.lon)
        try:
            self.store.update_robot_telemetry(device_id, data)
        except Exception as e:  # never fail an accepted transmission on this
            print(f"[robot-link] telemetry update failed for {device_id}: {e}")

    def _log_msg(self, msg: OpenedMessage, status: str, reason: Optional[str], transport: str,
                 received_at: str, capture_id: Optional[str] = None):
        self._log(status=status, reason=reason, transport=transport, received_at=received_at,
                  size_bytes=msg.size_bytes, authenticated=True, header=msg.header,
                  msg_id=msg.jti, device_id=msg.device_id, kid=msg.kid, seq=msg.seq,
                  content_type=msg.content_type, clock_skew_s=msg.clock_skew_s,
                  payload_sha256=msg.payload_sha256, capture_id=capture_id)

    def _log(self, **rec):
        seq = rec.get("seq")
        rec["seq"] = seq if isinstance(seq, int) and not isinstance(seq, bool) and 0 <= seq < 2**63 else None
        for k in ("clock_skew_s", "payload_sha256", "capture_id", "reason"):
            rec.setdefault(k, None)
        try:
            self.store.add_transmission(rec)
        except Exception as e:  # pragma: no cover
            print(f"[robot-link] could not log transmission: {e}")
