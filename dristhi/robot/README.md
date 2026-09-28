# DRISHTI Roaming Measurement Robot (Jetson + AWS IoT)

Edge software for the autonomous quarry-measurement robot (see
`../../smart_granite_block/Edge_AI_Robot_for_DRISHTI.md`). Runs on NVIDIA Jetson
with an OAK-D Pro stereo camera, and connects to the platform over
**AWS IoT Core** (MQTT, mutual TLS) — the same pattern used in previous
StartupOS robot deployments where a rover roamed the blocks.

## Connectivity (AWS IoT Core)
The robot **publishes** MQTT messages; the gateway **subscribes**:
```
drishti/robots/{robot_id}/telemetry   # position, battery, status (streamed while roaming)
drishti/robots/{robot_id}/blocks      # a measured granite block
```
Setup (free tier, ~500k msgs/month free): see `aws-iot/README.md`,
`aws-iot/provision.sh`, and `aws-iot/iot-policy.json`.

If AWS IoT is not configured, the robot transparently falls back to posting the
same payloads to the gateway over HTTP (`POST /robots/{id}/telemetry` and
`/robots/{id}/blocks`), so the roaming demo always works.

## On-robot pipeline
1. Navigate quarry zone (ROS2 + RPLiDAR SLAM, RTK GPS waypoints)
2. Roam between blocks, streaming telemetry to `.../telemetry`
3. Detect granite blocks (YOLOv11 on-device)
4. Capture multi-view stereo → point cloud → L×W×H + volume (convex hull),
   cross-validate with ToF laser
5. Publish each measured block to `.../blocks`; buffer offline, sync on reconnect

## Roaming from the UI (default, no terminal)
Clicking **Start survey** in the Robot Console dispatches the robot: the gateway
runs a **server-side roam engine** (`services/gateway/roam_engine.py`) that drives
the rover — roams between block waypoints, streams position/battery telemetry,
and measures each block through measure → assess → persist. **Stop survey** halts
it and returns the rover to the dock. Watch it live in the Robot Console's
**3D quarry scene** (Three.js): the tracked rover drives across the pit and the
granite blocks are rendered at their actual measured dimensions.

Optional query params on the start endpoint: `?blocks=6&step_sec=0.6`.

## Standalone simulator (AWS IoT / on-hardware path)
`sim_agent.py` runs the same roam as an external device — used to exercise the
**AWS IoT Core** transport or to stand in for a physical robot. Not needed for
the UI-driven demo.

```bash
# HTTP transport (posts telemetry + blocks to the gateway):
python3 sim_agent.py --robot DRISHTI-BOT-01 --blocks 6

# AWS IoT Core (after provisioning):
python3 sim_agent.py --transport aws --robot DRISHTI-BOT-01 \
  --endpoint xxxx-ats.iot.ap-south-1.amazonaws.com \
  --cert aws-iot/certs/device.pem.crt --key aws-iot/certs/private.pem.key \
  --ca aws-iot/certs/AmazonRootCA1.pem --blocks 6
```

## Real hardware deps (not needed for the simulator)
- ROS2 Humble, `depthai` (OAK-D), `rplidar_ros`, `ultralytics`, `open3d`
- `awsiotsdk` for the MQTT device connection
