from rules import assess, classify, GANGSAW_THRESHOLD_M3


def test_classification_boundary():
    assert classify(GANGSAW_THRESHOLD_M3 + 0.01) == "above_gangsaw"
    assert classify(GANGSAW_THRESHOLD_M3) == "below_gangsaw"


def test_fee_below_gangsaw():
    a = assess(2.0, "black_galaxy")
    assert a.classification == "below_gangsaw"
    assert a.seigniorage_fee_inr == round(2.0 * 2000.0, 2)


def test_fee_above_gangsaw_premium():
    a = assess(4.0, "black_galaxy")
    assert a.classification == "above_gangsaw"
    assert a.seigniorage_fee_inr == round(4.0 * 2000.0 * 1.25, 2)


def test_unknown_category_falls_back():
    a = assess(1.0, "unobtanium")
    assert a.granite_category == "generic"


def test_tonnage_and_rate_fields():
    # MT basis: volume * density (black_galaxy = 3.0 MT/m3).
    a = assess(2.0, "black_galaxy")
    assert a.tonnage_mt == round(2.0 * 3.0, 3)
    # Below-gangsaw effective rate equals the base rate.
    assert a.rate_per_m3_inr == 2000.0
    assert a.category_name == "Black Galaxy (Below Gangsaw)"
    assert a.threshold_m3 == GANGSAW_THRESHOLD_M3


def test_above_gangsaw_rate_includes_premium():
    a = assess(4.0, "black_galaxy")
    # Effective rate carries the 1.25x premium so base*volume == fee.
    assert a.rate_per_m3_inr == round(2000.0 * 1.25, 2)
    assert a.category_name == "Black Galaxy (Above Gangsaw)"


def test_form_m_levies_are_computed_by_the_engine():
    # 2.0 m3 black galaxy below gangsaw -> base 4000; DMF 10% + NMET 2%.
    a = assess(2.0, "black_galaxy")
    assert a.seigniorage_fee_inr == 4000.0
    assert a.dmf_inr == 400.0
    assert a.nmet_inr == 80.0
    assert a.total_payable_inr == 4480.0
    assert a.base_rate_per_m3_inr == 2000.0
    assert a.premium_multiplier == 1.0
    assert a.density_mt_per_m3 == 3.0


def test_registry_granite_types_are_recognised():
    # The shared quarry registry uses black_galaxy | colour | grey.
    colour = assess(1.0, "colour")
    assert colour.granite_category == "colour"
    assert colour.category_name == "Colour Granite (Below Gangsaw)"
    grey = assess(1.0, "grey")
    assert grey.granite_category == "generic"
    assert grey.rate_per_m3_inr == 1200.0


def test_assess_endpoint_exposes_levies():
    from fastapi.testclient import TestClient
    from main import app

    d = TestClient(app).post("/assess", json={"volume_m3": 4.0, "granite_category": "black_galaxy"}).json()
    assert d["classification"] == "above_gangsaw"
    assert d["seigniorage_fee_inr"] == 10000.0
    assert d["total_payable_inr"] == 11200.0
    assert d["premium_multiplier"] == 1.25
