# Edge AI Robot for Project DRISHTI
## Autonomous Quarry Measurement Robot with Depth Vision

---

## 1. Overview

This document specifies how the Edge AI Robot platform is adapted for **Project DRISHTI** — transforming the mobile robot into an autonomous granite block measurement unit that navigates quarry sites, detects blocks, measures dimensions using hardware stereo depth, and calculates seigniorage fees automatically.

**Core Value:** DRISHTI currently relies on manual mobile phone photography with monocular depth estimation (Depth Anything V2). The robot provides **hardware stereo depth** via OAK-D Pro, giving direct metric measurements accurate to ±2cm — far superior to monocular AI estimation. It also eliminates human effort by autonomously surveying quarry blocks.

---

## 2. DRISHTI Requirements Mapped to Robot Hardware

| DRISHTI Requirement | Standard Approach (Mobile App) | Robot Adaptation |
|--------------------|-------------------------------|-----------------|
| Granite block detection | YOLOv11 on cloud from phone photos | YOLOv11 on Jetson (edge, real-time, no upload needed) |
| Depth estimation | Depth Anything V2 (monocular, AI-estimated) | OAK-D Pro stereo depth (hardware, millimeter-accurate) |
| Reference calibration marker | Government-issued calibration board | Robot-mounted laser reference + stereo baseline (self-calibrating) |
| Dimension estimation | Geometric analysis from single phone photo | Multi-angle stereo reconstruction (robot drives around block) |
| GPS tagging | Phone GPS | RTK GPS module on robot (centimeter accuracy) |
| Image quality validation | Phone flash guidance | Controlled lighting (robot-mounted LED panels) |
| Volume calculation | L × W × H from estimated dimensions | Point cloud reconstruction → accurate convex hull volume |
| Classification (Above/Below Gangsaw) | From computed volume | Same — automated from measured volume |
| Seigniorage fee computation | Rules engine on cloud | Same rules engine, runs on Jetson locally |

---

## 3. Adapted Hardware Configuration

### 3.1 Compute — NVIDIA Jetson Orin Nano Super (₹21,000)

Running the DRISHTI measurement pipeline:
- **YOLOv11** block detection + instance segmentation (TensorRT, 60+ FPS)
- **Stereo depth processing** from OAK-D (real-time depth maps)
- **Point cloud generation** for 3D volume estimation
- **OpenCV geometric analysis** for dimension extraction
- **Classification + fee computation** engine (on-device)

### 3.2 Camera — Luxonis OAK-D Pro (₹16,800)

**Why stereo depth beats monocular estimation for DRISHTI:**

| Factor | Monocular (Depth Anything V2) | Stereo (OAK-D Pro) |
|--------|-------------------------------|---------------------|
| Accuracy | ±10-20cm typical | ±1-3cm at 2m range |
| Calibration needed | Yes (reference marker required) | Self-calibrated (known stereo baseline = 7.5cm) |
| Lighting dependency | High (affected by shadows, wet surfaces) | Low (IR structured light available) |
| Metric output | Relative depth → needs scaling | Absolute depth in millimeters directly |
| Multi-surface handling | Struggles with irregular shapes | Point cloud captures full 3D geometry |

**OAK-D Pro specifications for quarry use:**
- Stereo depth range: 0.2m to 35m (covers all granite block sizes)
- IR dot projector for structured light in shadowed areas
- 4K RGB for visual documentation
- Operates in 0°C to 50°C (suitable for AP quarry temperatures)

### 3.3 Additional Sensor — Laser Distance Sensor (₹2,500)

- TFMini-S or VL53L5X Time-of-Flight sensor
- Cross-validates stereo depth measurements
- Provides ground-truth calibration point for each scan
- Range: 0.1m to 12m, accuracy ±1cm

### 3.4 Mobility Platform — Tracked Chassis (₹10,000)

**Changed from 4WD wheels to tracked/tank chassis for quarry terrain:**
- Handles loose gravel, dust, uneven rock surfaces
- Climbs over small debris (up to 5cm obstacles)
- Better traction on dusty/wet quarry floor
- Payload capacity: 5kg+ (sufficient for all electronics)
- IP54 dust protection for quarry environment

### 3.5 GPS — RTK GPS Module (₹8,000)

- **Standard GPS:** ±2-5m accuracy (insufficient for quarry block mapping)
- **RTK GPS (e.g., SparkFun RTK Express):** ±2cm accuracy
- Each block measurement tagged with centimeter-accurate coordinates
- Enables quarry-wide block inventory mapping
- Prevents GPS spoofing through RTK correction signals

### 3.6 Lighting — LED Panel Array (₹2,000)

- Controlled, consistent illumination for photography
- Eliminates shadow artifacts that confuse depth estimation
- Essential for quarry pits with variable lighting
- Ring-mounted around camera for uniform illumination

---

## 4. DRISHTI Measurement Pipeline on Robot

### 4.1 Autonomous Quarry Survey Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                  AUTONOMOUS SURVEY MODE                       │
└─────────────────────────────────────────────────────────────┘

Step 1: NAVIGATE TO QUARRY ZONE
    Robot navigates to designated quarry survey area via RTK GPS waypoints.
    LiDAR provides obstacle avoidance around quarry equipment.

Step 2: DETECT GRANITE BLOCKS
    OAK-D Pro scans surroundings.
    YOLOv11 detects and segments individual granite blocks.
    Each block assigned a unique Block-ID.

Step 3: APPROACH EACH BLOCK
    Robot navigates to optimal measurement position (1-2m from block face).
    Multiple viewpoints captured (front, side, top if accessible).

Step 4: MEASURE DIMENSIONS
    Stereo depth → dense point cloud of block surface.
    Segment block from background (ground plane removal).
    Fit bounding box → extract Length, Width, Height.
    Compute volume via convex hull on point cloud.
    Cross-validate with ToF laser measurement.

Step 5: CLASSIFY & COMPUTE FEE
    Volume → Above Gangsaw (>2.5 m³) or Below Gangsaw.
    Map to granite category per AP government schedule.
    Compute seigniorage fee automatically.

Step 6: LOG & MOVE TO NEXT BLOCK
    Store: RGB photo + depth map + dimensions + GPS + fee + confidence score.
    Move to next detected block. Repeat Steps 3-5.

Step 7: GENERATE SURVEY REPORT
    After all blocks measured, compile quarry survey report.
    Transmit to DRISHTI cloud platform via WiFi/4G.
```

### 4.2 Measurement Accuracy Comparison

| Method | L × W × H Accuracy | Volume Accuracy | Time per Block | Human Effort |
|--------|--------------------|-----------------|-|---|
| Manual tape measure | ±2cm | ±5% | 5-10 min | 2 officers |
| Mobile phone (DRISHTI v1) | ±10-20cm | ±15-20% | 1-2 min | 1 officer + phone |
| **Robot (this design)** | **±2-3cm** | **±3-5%** | **30-60 sec** | **Zero (autonomous)** |

---

## 5. 3D Point Cloud Measurement Approach

Unlike DRISHTI's monocular approach that estimates a single depth map from one photo, the robot captures full 3D geometry:

### Multi-View Reconstruction
```
Position 1 (Front)     Position 2 (Side)     Position 3 (Top view)
    ┌───┐                  ┌───┐                 ┌─────────┐
    │   │ → depth map 1    │   │ → depth map 2   │         │ → depth map 3
    │   │                  │   │                  └─────────┘
    └───┘                  └───┘
         \                  |                  /
          \                 |                 /
           ▼               ▼                ▼
         ┌────────────────────────────────────┐
         │    MERGED 3D POINT CLOUD           │
         │    (complete block geometry)        │
         └──────────────────┬─────────────────┘
                            │
                            ▼
         ┌────────────────────────────────────┐
         │  ORIENTED BOUNDING BOX FIT         │
         │  L = 2.34m, W = 1.12m, H = 0.87m  │
         │  Volume = 2.28 m³                   │
         │  Classification: Below Gangsaw      │
         │  Seigniorage: ₹X per schedule       │
         └────────────────────────────────────┘
```

### Advantages Over Single-Photo Approach:
1. **Complete geometry** — captures all visible faces, not just front
2. **Handles irregular shapes** — point cloud captures curves and chips
3. **No reference marker needed** — stereo baseline provides absolute scale
4. **Shadow-proof** — robot-mounted LEDs eliminate lighting issues
5. **Repeatable** — same measurement process every time (no human variability)

---

## 6. Handling DRISHTI's Known Challenges

| DRISHTI Risk | How Robot Solves It |
|-------------|---------------------|
| Variable quarry conditions (dust, lighting) | Robot-mounted LED panels + IR structured light on OAK-D |
| Irregular block shapes | Point cloud + convex hull volume (not L×W×H approximation) |
| GPS spoofing | RTK GPS with correction signals + robot odometry cross-check |
| Network connectivity at quarries | Full offline processing; stores results, syncs when connected |
| Calibration accuracy | Hardware stereo = self-calibrated; no external marker needed |
| Wet/reflective surfaces | IR dot projector provides depth even on wet granite |
| Human measurement variability | Eliminated — robot measures identically every time |

---

## 7. Integration with DRISHTI Cloud Platform

The robot operates as a field measurement device that feeds into DRISHTI's existing architecture:

```
┌──────────────────────────────────────────────────────────┐
│              QUARRY SITE (Offline)                         │
│                                                          │
│  ┌────────────────────────────┐                          │
│  │  DRISHTI MEASUREMENT ROBOT │                          │
│  │  ┌──────┐  ┌──────┐       │                          │
│  │  │OAK-D │  │Jetson│       │                          │
│  │  │Pro   │→ │YOLO  │→ Measure → Store locally         │
│  │  └──────┘  │+Depth│       │                          │
│  │            └──────┘       │                          │
│  └─────────────┬──────────────┘                          │
│                │ (WiFi/4G when available)                 │
└────────────────┼─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│              DRISHTI CLOUD PLATFORM                        │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ API      │  │ Seigniorage  │  │ OMEPS 2.0        │   │
│  │ Gateway  │→ │ Engine       │→ │ Integration      │   │
│  │(Spring   │  │(Fee compute) │  │(Govt system sync)│   │
│  │ Boot 3)  │  │              │  │                  │   │
│  └──────────┘  └──────────────┘  └──────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │            DMGO OFFICER DASHBOARD                 │    │
│  │  - Block measurements (auto-computed)            │    │
│  │  - RGB photos + depth maps (evidence)            │    │
│  │  - GPS coordinates per block                     │    │
│  │  - Confidence scores                             │    │
│  │  - Fee assessment (auto-calculated)              │    │
│  │  - Anomaly flags (measurement vs weighbridge)    │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### API Payload from Robot (per block):

```json
{
  "block_id": "QRY-AMR-2026-0847",
  "quarry_id": "APQRY-0023",
  "timestamp": "2026-08-26T10:34:12+05:30",
  "gps": {"lat": 16.5734, "lon": 80.3567, "accuracy_cm": 2},
  "dimensions": {
    "length_m": 2.34,
    "width_m": 1.12,
    "height_m": 0.87,
    "confidence": 0.94
  },
  "volume_m3": 2.28,
  "measurement_method": "stereo_pointcloud_multiview",
  "classification": "below_gangsaw",
  "seigniorage_fee_inr": 4560,
  "evidence": {
    "rgb_images": ["front.jpg", "side.jpg", "top.jpg"],
    "depth_maps": ["front_depth.png", "side_depth.png"],
    "pointcloud": "block_0847.ply"
  },
  "robot_metadata": {
    "robot_id": "DRISHTI-BOT-01",
    "battery_percent": 72,
    "measurement_duration_sec": 45
  }
}
```

---

## 8. DRISHTI-Specific Bill of Materials

| Component | Purpose (DRISHTI Context) | Cost (₹) |
|-----------|--------------------------|-----------|
| Jetson Orin Nano Super | YOLOv11 block detection + stereo depth processing | 21,000 |
| OAK-D Pro | Hardware stereo depth (±2cm accuracy) + 4K evidence photos | 16,800 |
| RPLiDAR A2 | Autonomous navigation through quarry | 16,800 |
| Tracked chassis + motors | Quarry terrain traversal (gravel, dust, uneven) | 10,000 |
| ESP32-S3 + motor drivers | Motor control + odometry | 2,500 |
| RTK GPS module | Centimeter-accurate block location tagging | 8,000 |
| ToF laser sensor (TFMini-S) | Cross-validation of stereo depth | 2,500 |
| LED panel array | Consistent illumination for measurement | 2,000 |
| 4G LTE module | Data sync to DRISHTI cloud | 2,000 |
| 3S LiPo (10000mAh) | Extended quarry survey time (~3 hrs) | 5,000 |
| DC-DC converters + wiring | Power distribution | 2,100 |
| Dust/weather enclosure (IP54) | Quarry dust protection | 2,500 |
| Misc (mounts, connectors) | Assembly | 2,000 |
| **TOTAL** | | **₹93,200** |

---

## 9. Performance Targets (Aligned to DRISHTI Success Metrics)

| DRISHTI Metric | Mobile App Target | Robot Target | Improvement |
|---------------|-------------------|----|---|
| Dimension accuracy | >95% (within 5cm) | >98% (within 2-3cm) | 2× better |
| Volume accuracy | >90% | >97% (point cloud) | Significant improvement |
| AI confidence score | >85% for 80% of blocks | >92% for 95% of blocks | Better consistency |
| Physical inspection reduction | 70% | 95% (fully autonomous) | Near-full automation |
| Processing time per block | <30 seconds (upload+cloud) | <60 seconds (multi-view, but no upload) | Comparable, richer data |
| OMEPS 2.0 sync | 100% | 100% (same API) | Same |

### Robot-Specific Metrics:
- Blocks measured per hour: 40-60 (autonomous, no human needed)
- Quarry coverage: Full site survey in 2-3 hours
- Terrain handling: Traverses gravel slopes up to 15°
- Dust resistance: Operates in standard quarry dust conditions (IP54)
- Repeat measurement variance: <1cm (eliminates human variability)

---

## 10. Operational Workflow for DMGO Officers

### Before Robot (Current):
1. Officer drives to quarry (30-60 min)
2. Manually photographs each block with phone (2 min/block)
3. Waits for cloud processing (30 sec/block)
4. Reviews AI estimates, manually verifies suspicious ones
5. Approves measurements, fee computed
6. Total: 4-6 hours for 50-block quarry, requires 1-2 officers on-site

### With Robot (Proposed):
1. Robot deployed at quarry (can be pre-positioned or driven)
2. Officer triggers survey from dashboard (remote or on-site)
3. Robot autonomously navigates, detects, and measures all blocks
4. Results stream to DMGO dashboard with evidence
5. Officer reviews high-confidence results (approve in batch)
6. Officer visits only for low-confidence measurements (<5% of blocks)
7. Total: 2-3 hours (robot autonomous), officer reviews remotely in 30 min

**Efficiency gain: 80% reduction in officer field time**

---

## 11. Development Roadmap

| Phase | Duration | Deliverables |
|-------|----------|-------------|
| Phase 1: Block Detection | Week 1-2 | YOLOv11 trained on granite blocks, runs on Jetson |
| Phase 2: Stereo Measurement | Week 3-4 | OAK-D depth → point cloud → dimension extraction |
| Phase 3: Multi-View Fusion | Week 5 | Robot captures multiple angles, fuses into single 3D model |
| Phase 4: Quarry Navigation | Week 6-7 | Tracked chassis, SLAM on quarry terrain, waypoint navigation |
| Phase 5: Fee Engine + API | Week 8 | Seigniorage computation, DRISHTI platform API integration |
| Phase 6: Field Validation | Week 9-10 | Test at real quarry, compare vs manual measurements |

---

## 12. Sources

- [NVIDIA Jetson Orin Nano Super Developer Kit](https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/nano-super-developer-kit)
- [Luxonis OAK-D Pro — Stereo Depth Documentation](https://docs.luxonis.com/hardware/products/OAK-D)
- [RealSense vs OAK-D for Robotics Depth](https://fictionlab.pl/blog/intel-realsense-d435-vs-oak-d-lite-which-depth-camera-for-mobile-robotics-research/)
- [Empirical Comparison of Depth Cameras for Robotics](https://arxiv.org/abs/2501.07421)
- [RPLiDAR A2 with ROS2 Cartographer](https://openelab.io/fi/blogs/learn/rplidar-a1-ros2-driver-cartographer-slam-guide)
- [YOLOv11 Object Detection](https://github.com/ultralytics/ultralytics)

Content was rephrased for compliance with licensing restrictions.
