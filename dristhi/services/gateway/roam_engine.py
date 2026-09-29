"""
Server-side roam engine.

Drives the robot from the Robot Console's "Start survey" button (no terminal
command). A background thread per robot:
  * roams between granite-block waypoints around the robot's HOME quarry,
    streaming FINE-GRAINED position/battery/status telemetry so the 3D console
    shows continuous, smooth movement (not teleport-between-polls),
  * measures a block at each waypoint via the shared measure->assess->persist
    pipeline (ingest_block), and
  * returns to its home dock/godown to RECHARGE when the battery runs low, then
    resumes the survey.

"Stop survey" signals the thread to finish and drive back to the dock.

On real hardware the same telemetry + block messages arrive over AWS IoT Core;
the store update path is identical, so the console behaves the same either way.
"""
from __future__ import annotations

import math
import random
import threading
import time
from typing import Callable

_M_PER_DEG = 111_320.0
_LOW_BATTERY = 22.0      # below this, head home to recharge
_FULL_BATTERY = 100.0
_DRAIN_PER_STEP = 0.7    # battery % consumed per roam step
_STEPS_PER_LEG = 16      # fine interpolation steps between waypoints (smooth!)


def _offset(lat0, lon0, east_m, north_m):
    dlat = north_m / _M_PER_DEG
    dlon = east_m / (_M_PER_DEG * math.cos(math.radians(lat0)))
    return lat0 + dlat, lon0 + dlon


def _quarry_waypoints(home_lat, home_lon, n):
    """Block positions laid out in rows across the pit (mirrors the seed layout),
    so the rover visibly drives to where the granite blocks actually are."""
    cols, gap = 4, 28
    pts = []
    for i in range(n):
        row, col = divmod(i, cols)
        east = (col - (cols - 1) / 2) * gap
        north = (row - 1) * gap - 10
        pts.append(_offset(home_lat, home_lon, east, north))
    return pts


class RoamEngine:
    """Manages one background roam thread per robot."""

    def __init__(self, update_telemetry: Callable[[str, dict], None],
                 ingest_block: Callable[[str, dict], dict]):
        self._update_telemetry = update_telemetry
        self._ingest_block = ingest_block
        self._threads: dict[str, threading.Thread] = {}
        self._stops: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def is_running(self, robot_id: str) -> bool:
        t = self._threads.get(robot_id)
        return bool(t and t.is_alive())

    def start(self, robot_id: str, quarry_id: str = "APQRY-0023",
              home_lat: float = 16.5734, home_lon: float = 80.3567,
              blocks: int = 6, step_sec: float = 0.25, battery: float = 100.0):
        with self._lock:
            if self.is_running(robot_id):
                return
            stop = threading.Event()
            self._stops[robot_id] = stop
            t = threading.Thread(
                target=self._run,
                args=(robot_id, quarry_id, home_lat, home_lon, blocks, step_sec, stop, battery),
                daemon=True, name=f"roam-{robot_id}",
            )
            self._threads[robot_id] = t
            t.start()

    def stop(self, robot_id: str):
        with self._lock:
            ev = self._stops.get(robot_id)
            if ev:
                ev.set()

    # ---- background worker ----
    def _run(self, robot_id, quarry_id, home_lat, home_lon, blocks, step_sec, stop, battery=100.0):
        state = {"lat": home_lat, "lon": home_lon, "battery": float(battery)}

        def emit(status, waypoint):
            try:
                self._update_telemetry(robot_id, {
                    "status": status, "battery_percent": int(round(state["battery"])),
                    "lat": round(state["lat"], 6), "lon": round(state["lon"], 6),
                    "waypoint": waypoint,
                })
            except Exception as e:  # pragma: no cover
                # A transient store error must not kill the roam thread mid-drive,
                # or the robot would freeze. Log and keep roaming; the next tick
                # will try again.
                print(f"[roam] {robot_id} telemetry emit failed: {e}")

        def drive_to(tlat, tlon, status, waypoint, drain=True):
            """Interpolate from current position to target over many fine steps
            so the console animates continuous motion. Returns False if stopped."""
            slat, slon = state["lat"], state["lon"]
            for s in range(1, _STEPS_PER_LEG + 1):
                if stop.is_set():
                    return False
                f = s / _STEPS_PER_LEG
                # ease-in-out for natural acceleration/deceleration
                fe = 0.5 - 0.5 * math.cos(f * math.pi)
                state["lat"] = slat + (tlat - slat) * fe
                state["lon"] = slon + (tlon - slon) * fe
                if drain:
                    state["battery"] = max(0.0, state["battery"] - _DRAIN_PER_STEP)
                emit(status, waypoint)
                time.sleep(step_sec)
            state["lat"], state["lon"] = tlat, tlon
            return True

        def recharge():
            """Drive home and recharge to full."""
            if not drive_to(home_lat, home_lon, "returning", "-> home dock (low battery)"):
                return False
            emit("charging", "charge-dock")
            # Refill in visible increments.
            while state["battery"] < _FULL_BATTERY:
                if stop.is_set():
                    return False
                state["battery"] = min(_FULL_BATTERY, state["battery"] + 6.0)
                emit("charging", "charge-dock")
                time.sleep(step_sec)
            emit("surveying", "resuming survey")
            return True

        emit("surveying", "leaving dock")
        waypoints = _quarry_waypoints(home_lat, home_lon, blocks)

        for i, (tlat, tlon) in enumerate(waypoints):
            if stop.is_set():
                break
            # Recharge before heading out if too low to complete the next leg.
            if state["battery"] <= _LOW_BATTERY:
                if not recharge():
                    break

            block_id = f"QRY-SIM-{int(time.time())}-{i:03d}"
            if not drive_to(tlat, tlon, "surveying", f"-> {block_id}"):
                break

            # Reached the block: measure it, tagged with the rover's GPS.
            try:
                self._ingest_block(robot_id, {
                    "block_id": block_id, "quarry_id": quarry_id, "source": "robot",
                    "lat": round(state["lat"], 6), "lon": round(state["lon"], 6),
                    "granite_category": "black_galaxy", "image_ref": f"sim/{block_id}.ply",
                    "via": "roam-engine",
                })
            except Exception as e:  # pragma: no cover
                print(f"[roam] {robot_id} block {block_id} failed: {e}")
            # Dwell at the block while it scans (a few frames of telemetry).
            for _ in range(4):
                if stop.is_set():
                    break
                emit("surveying", f"measured {block_id}")
                time.sleep(step_sec)

        # Drive back to the dock and go idle.
        drive_to(home_lat, home_lon, "returning", "-> home dock", drain=False)
        state["lat"], state["lon"] = home_lat, home_lon
        emit("idle", "dock")
        with self._lock:
            self._threads.pop(robot_id, None)
            self._stops.pop(robot_id, None)
