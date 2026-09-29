"""
Quarry registry used by the portal-side calculation pipeline.

The robot only reports which quarry it is deployed at; the gateway decides
what that means: the granite category used for seigniorage and the concession
geofence the capture's GNSS fix is checked against.

ROBOT_QUARRIES mirrors packages/ui/src/quarries.ts (the registry the Robot View
deploys against). Quarries that exist only in the demo store (store.QUARRIES)
resolve too, but without a geofence.
"""
from __future__ import annotations

import math
from typing import Optional

_M_PER_DEG_LAT = 111_320.0

ROBOT_QUARRIES = [
    {"quarry_id": "APQRY-0023", "name": "Chimakurthy Black Galaxy Quarry", "district": "Prakasam",
     "granite_category": "black_galaxy", "lat": 15.5810, "lon": 79.8620, "half_width_m": 320, "half_height_m": 260},
    {"quarry_id": "APQRY-0117", "name": "Ongole Galaxy Extraction Pit", "district": "Prakasam",
     "granite_category": "black_galaxy", "lat": 15.5057, "lon": 80.0447, "half_width_m": 280, "half_height_m": 300},
    {"quarry_id": "APQRY-0245", "name": "Srikakulam Blue Granite Field", "district": "Srikakulam",
     "granite_category": "srikakulam_blue", "lat": 18.2969, "lon": 83.8974, "half_width_m": 360, "half_height_m": 240},
    {"quarry_id": "APQRY-0388", "name": "Chittoor Grey Granite Bench", "district": "Chittoor",
     "granite_category": "grey", "lat": 13.2172, "lon": 79.1003, "half_width_m": 300, "half_height_m": 300},
    {"quarry_id": "APQRY-0451", "name": "Anantapur Colour Granite Pit", "district": "Anantapur",
     "granite_category": "colour", "lat": 14.6819, "lon": 77.6006, "half_width_m": 340, "half_height_m": 220},
    {"quarry_id": "APQRY-0512", "name": "Guntur Pearl Galaxy Bench", "district": "Guntur",
     "granite_category": "black_galaxy", "lat": 16.3067, "lon": 80.4365, "half_width_m": 300, "half_height_m": 280},
    {"quarry_id": "APQRY-0574", "name": "Kurnool Multi-Colour Pit", "district": "Kurnool",
     "granite_category": "colour", "lat": 15.8281, "lon": 78.0373, "half_width_m": 320, "half_height_m": 260},
    {"quarry_id": "APQRY-0619", "name": "Kadapa Green Marble Quarry", "district": "Kadapa",
     "granite_category": "colour", "lat": 14.4673, "lon": 78.8242, "half_width_m": 300, "half_height_m": 260},
    {"quarry_id": "APQRY-0688", "name": "Nellore Grey Granite Field", "district": "Nellore",
     "granite_category": "grey", "lat": 14.4426, "lon": 79.9865, "half_width_m": 300, "half_height_m": 300},
    {"quarry_id": "APQRY-0742", "name": "Vizianagaram Silver Grey Bench", "district": "Vizianagaram",
     "granite_category": "grey", "lat": 18.1066, "lon": 83.3956, "half_width_m": 300, "half_height_m": 280},
]
_BY_ID = {q["quarry_id"]: q for q in ROBOT_QUARRIES}


def get_quarry(quarry_id: str) -> Optional[dict]:
    q = _BY_ID.get(quarry_id)
    if q:
        return dict(q)
    try:  # demo-store quarries (seed data): known, but no concession geofence
        from store import QUARRY_BY_ID
    except Exception:  # pragma: no cover
        return None
    s = QUARRY_BY_ID.get(quarry_id)
    if not s:
        return None
    return {**s, "granite_category": "generic", "half_width_m": None, "half_height_m": None}


def geofence(quarry: Optional[dict], lat: Optional[float], lon: Optional[float]) -> dict:
    """Rectangular concession check (same geometry as the UI's pointInQuarry)."""
    if not quarry or lat is None or lon is None or not quarry.get("half_width_m"):
        return {"checked": False, "reason": "no GNSS fix" if lat is None else "no concession boundary on record"}
    north = (lat - quarry["lat"]) * _M_PER_DEG_LAT
    east = (lon - quarry["lon"]) * _M_PER_DEG_LAT * math.cos(math.radians(quarry["lat"]))
    inside = abs(east) <= quarry["half_width_m"] and abs(north) <= quarry["half_height_m"]
    return {
        "checked": True, "inside": inside,
        "offset_east_m": round(east, 1), "offset_north_m": round(north, 1),
        "distance_to_centre_m": round(math.hypot(east, north)),
        "half_width_m": quarry["half_width_m"], "half_height_m": quarry["half_height_m"],
    }
