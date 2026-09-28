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
