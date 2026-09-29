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
    # Other colour granites (Anantapur, Kurnool, Kadapa pits in the quarry
    # registry). Placeholder: priced like Srikakulam Blue until gazetted.
    "colour": 1500.0,
    "generic": 1200.0,
}

# Category keys used by the shared quarry registry / field-capture UI that are
# synonyms of an engine category.
CATEGORY_ALIASES = {
    "grey": "generic",
    "gray": "generic",
}

# Above-gangsaw blocks attract a premium multiplier in this demo model.
ABOVE_GANGSAW_MULTIPLIER = 1.25

# Levies charged on top of the base seigniorage (Form-M challan). Illustrative
# rates matching the Portal's Form-M panel: District Mineral Foundation 10%,
# National Mineral Exploration Trust 2% of the base seigniorage.
DMF_RATE = 0.10
NMET_RATE = 0.02

# Granite density (MT per m3) by category — used to derive the Metric-Tonne
# basis the AP DMG assesses on. Mirrors the reference demo's DENSITY table.
GRANITE_DENSITY_MT_PER_M3 = {
    "black_galaxy": 3.0,
    "srikakulam_blue": 2.75,
    "colour": 2.75,
    "generic": 2.65,
}

# Human-readable category labels (with above/below gangsaw suffix), matching the
# reference demo's RATE_SCHEDULE names so both UIs show the same wording.
_CATEGORY_LABELS = {
    "black_galaxy": "Black Galaxy",
    "srikakulam_blue": "Srikakulam Blue",
    "colour": "Colour Granite",
    "generic": "Grey/Common Granite",
}


@dataclass
class Assessment:
    classification: str
    granite_category: str
    seigniorage_fee_inr: float
    rate_per_m3_inr: float
    tonnage_mt: float
    category_name: str
    threshold_m3: float
    # Derivation inputs + Form-M levies, so callers can show (and audit) every
    # step of the calculation without re-implementing any of it.
    base_rate_per_m3_inr: float = 0.0
    premium_multiplier: float = 1.0
    density_mt_per_m3: float = 0.0
    dmf_inr: float = 0.0
    nmet_inr: float = 0.0
    total_payable_inr: float = 0.0


def classify(volume_m3: float) -> str:
    return "above_gangsaw" if volume_m3 > GANGSAW_THRESHOLD_M3 else "below_gangsaw"


def normalize_category(granite_category: str) -> str:
    key = (granite_category or "").strip().lower()
    key = CATEGORY_ALIASES.get(key, key)
    return key if key in GRANITE_RATES else "generic"


def assess(volume_m3: float, granite_category: str = "generic") -> Assessment:
    category = normalize_category(granite_category)
    base_rate = GRANITE_RATES[category]
    classification = classify(volume_m3)
    multiplier = ABOVE_GANGSAW_MULTIPLIER if classification == "above_gangsaw" else 1.0
    # Effective per-m3 rate including the above-gangsaw premium, so the UI can
    # render "Base Seigniorage (@ rate/m3)" consistently with the total fee.
    rate = base_rate * multiplier
    fee = round(volume_m3 * rate, 2)
    dmf = round(fee * DMF_RATE, 2)
    nmet = round(fee * NMET_RATE, 2)
    density = GRANITE_DENSITY_MT_PER_M3.get(category, 2.65)
    tonnage = volume_m3 * density
    label = _CATEGORY_LABELS.get(category, category)
    suffix = "Above Gangsaw" if classification == "above_gangsaw" else "Below Gangsaw"
    return Assessment(
        classification=classification,
        granite_category=category,
        seigniorage_fee_inr=fee,
        rate_per_m3_inr=round(rate, 2),
        tonnage_mt=round(tonnage, 3),
        category_name=f"{label} ({suffix})",
        threshold_m3=GANGSAW_THRESHOLD_M3,
        base_rate_per_m3_inr=base_rate,
        premium_multiplier=multiplier,
        density_mt_per_m3=density,
        dmf_inr=dmf,
        nmet_inr=nmet,
        total_payable_inr=round(fee + dmf + nmet, 2),
    )
