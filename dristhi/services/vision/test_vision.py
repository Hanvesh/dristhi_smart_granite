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


def test_field_estimate_marker_scale():
    """A 200mm marker spanning 100px => 0.002 m/px. A 1000px x 500px x 400px
    block => 2.0 x 1.0 x 0.8 m before fill factor."""
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)
    res = client.post("/estimate-field", json={
        "marker_real_mm": 200, "marker_pixels": 100,
        "block_length_px": 1000, "block_width_px": 500, "block_height_px": 400,
        "perspective_correction": 1.0, "fill_factor": 1.0,
    })
    assert res.status_code == 200
    d = res.json()
    assert d["metres_per_pixel"] == 0.002
    assert d["length_m"] == 2.0
    assert d["width_m"] == 1.0
    assert d["height_m"] == 0.8
    assert d["volume_m3"] == round(2.0 * 1.0 * 0.8, 4)
    assert d["measurement_method"] == "aruco_marker_scale_v1"
    assert 0.6 <= d["confidence"] <= 0.98


def test_lidar_measure_orders_extents_and_applies_fill():
    """Raw robot extents (x=1.0, y=2.0, z=0.8) => L=2.0 (longer horizontal),
    W=1.0, H=0.8; with fill 1.0 the volume is exactly L*W*H."""
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)
    res = client.post("/measure/lidar", json={
        "block_id": "QRY-TEST-LIDAR", "extent_x_m": 1.0, "extent_y_m": 2.0,
        "extent_z_m": 0.8, "point_count": 60000, "fill_factor": 1.0,
    })
    assert res.status_code == 200
    d = res.json()
    assert (d["length_m"], d["width_m"], d["height_m"]) == (2.0, 1.0, 0.8)
    assert d["volume_m3"] == 1.6
    assert d["measurement_method"] == "robot_lidar_obb_v1"
    # 60k points over 2*(2 + 1.6 + 0.8) = 8.8 m2 is well past full density.
    assert d["confidence"] == 0.99


def test_lidar_measure_default_fill_and_sparse_scan():
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)
    d = client.post("/measure/lidar", json={
        "block_id": "QRY-TEST-SPARSE", "extent_x_m": 2.0, "extent_y_m": 1.0,
        "extent_z_m": 1.0, "point_count": 0,
    }).json()
    assert d["fill_factor"] == 0.97
    assert d["volume_m3"] == round(2.0 * 1.0 * 1.0 * 0.97, 3)
    # No points => lowest confidence tier (still bounded).
    assert d["confidence"] == 0.7


def test_lidar_measure_rejects_non_physical_extents():
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)
    res = client.post("/measure/lidar", json={
        "block_id": "QRY-TEST-BAD", "extent_x_m": -1.0, "extent_y_m": 1.0,
        "extent_z_m": 1.0, "point_count": 10,
    })
    assert res.status_code == 422
