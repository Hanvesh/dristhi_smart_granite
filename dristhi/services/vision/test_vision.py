from estimator import MockEstimator


def test_deterministic():
    e = MockEstimator()
    a = e.estimate("QRY-TEST-001", "mobile")
    b = e.estimate("QRY-TEST-001", "mobile")
    assert a == b


def test_ranges_and_volume():
    e = MockEstimator()
    m = e.estimate("QRY-TEST-002", "robot")
    assert 1.5 <= m.length_m <= 3.5
    assert 0.8 <= m.width_m <= 1.8
    assert 0.6 <= m.height_m <= 1.5
    assert round(m.length_m * m.width_m * m.height_m, 2) == m.volume_m3
    assert m.method == "robot_stereo_pointcloud"
    assert 0.0 < m.confidence <= 0.99
