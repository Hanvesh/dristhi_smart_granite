"""
Seigniorage rules engine.

PLACEHOLDER SLABS: the rates below are GENERIC demo values, not the official AP
government schedule. Replace GRANITE_RATES and the gangsaw threshold with the
gazetted seigniorage schedule when available.

Classification rule (from the proposal / robot doc):
  volume > GANGSAW_THRESHOLD_M3  -> "above_gangsaw"
  otherwise                      -> "below_gangsaw"
"""
from dataclasses import dataclass

GANGSAW_THRESHOLD_M3 = 2.5  # blocks larger than this are "above gangsaw"

# Generic per-cubic-metre seigniorage rate (INR/m3) by granite category.
# Replace with the official AP schedule (typically levied per Metric Tonne).
GRANITE_RATES = {
    "black_galaxy": 2000.0,
    "srikakulam_blue": 1500.0,
    "generic": 1200.0,
}

# Above-gangsaw blocks attract a premium multiplier in this demo model.
ABOVE_GANGSAW_MULTIPLIER = 1.25


@dataclass
class Assessment:
    classification: str
    granite_category: str
    seigniorage_fee_inr: float


def classify(volume_m3: float) -> str:
    return "above_gangsaw" if volume_m3 > GANGSAW_THRESHOLD_M3 else "below_gangsaw"


def assess(volume_m3: float, granite_category: str = "generic") -> Assessment:
    category = granite_category if granite_category in GRANITE_RATES else "generic"
    rate = GRANITE_RATES[category]
    classification = classify(volume_m3)
    fee = volume_m3 * rate
    if classification == "above_gangsaw":
        fee *= ABOVE_GANGSAW_MULTIPLIER
    return Assessment(classification, category, round(fee, 2))
