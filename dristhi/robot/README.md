# DRISHTI Roaming Measurement Robot (Jetson + AWS IoT)

Edge software for the autonomous quarry-measurement robot (see
`../../smart_granite_block/Edge_AI_Robot_for_DRISHTI.md`). Runs on NVIDIA Jetson
with an OAK-D Pro stereo camera, and connects to the platform over
**AWS IoT Core** (MQTT, mutual TLS) — the same pattern used in previous
StartupOS robot deployments where a rover roamed the blocks.

## Responsibility split
The robot **captures and transmits raw sensor data only**. Volume, gangsaw
classification, seigniorage, Form-M levies, tonnage, geofence checks, OMEPS
reconciliation and approvals are all computed on the Portal side
(`services/gateway/pipeline.py` → vision + seigniorage services). The gateway
enforces this: capture payloads (`drishti.robot.capture/v1`) that contain any
derived or business field are rejected.

## Secure transmission (`drishti_link.py`, protocol `drishti-robot-link/v1`)
1. **Session key**: ephemeral ECDH P-256 key agreement with the gateway
   (`POST /robot-link/sessions`, robot-operator token), HKDF-SHA256 → AES-256
   key. The key never crosses the network; sessions last 15 min / 10,000
   messages and can be revoked.
2. **Every message** is a JWE compact envelope (RFC 7516, `dir` + `A256GCM`)
   with a fresh 96-bit IV; the protected header (key id, device, seq, message
   id, timestamp) is authenticated as AAD.
3. **Replay protection**: single-use message id, sequence number inside a
   64-message anti-replay window, ±5 min timestamp window.
4. **Transport**: HTTPS `POST /robot-link/ingest` or AWS IoT Core (mutual TLS).
   Run the gateway behind TLS in production; the envelope layer is defense in
   depth, not a replacement.

The browser Robot View (`apps/robot-console`) implements the same protocol with
WebCrypto (non-extractable keys; requires HTTPS or localhost).

## Connectivity (AWS IoT Core)
The robot **publishes** envelopes; the gateway bridge **subscribes**:
```
drishti/robots/{robot_id}/telemetry   # raw position, battery, status
drishti/robots/{robot_id}/captures    # a raw sensor capture of a block
```
Setup (free tier, ~500k msgs/month free): see `aws-iot/README.md`,
`aws-iot/provision.sh`, `aws-iot/iot-policy.json` (per-thing least privilege)
and `aws-iot/iot-bridge-policy.json`.

Without AWS IoT the robot posts the same envelopes to `POST /robot-link/ingest`.
The old plaintext endpoints (`/robots/{id}/telemetry`, `/robots/{id}/blocks`)
now return 410.

## On-robot pipeline
1. Navigate quarry zone (ROS2 + RPLiDAR SLAM, RTK GPS waypoints)
2. Roam between blocks, streaming raw telemetry
3. Detect granite blocks (YOLOv11 on-device) to know where to scan
4. Capture: LiDAR cluster extents + point count, RGB evidence frame (hash),
   RTK GNSS fix
5. Seal and transmit each capture; hold it on the robot and retransmit if the
   link is down (the gateway de-duplicates by `capture_id`)

## Robot View (default, no terminal)
Operators open the **Robot View** from the Portal (header link "Robot View ↗")
and return with "← Back to Portal". The Robot View simulates the rover in the
browser (Three.js scene): it drives to each block, captures raw readings, seals
them with WebCrypto and transmits them. Results appear in the Portal under
**Data Transmission → Calculations → Approvals**.

The older server-side roam engine (`POST /robots/{id}/survey`,
`services/gateway/roam_engine.py`) still exists for API demos; it generates
blocks inside the gateway and does not use the robot link.

## Standalone simulator (AWS IoT / on-hardware path)
`sim_agent.py` stands in for a physical robot: it captures raw readings and
transmits them over the secure link. Needs `pip install cryptography==50.0.1`.

```bash
# HTTP transport (sealed envelopes to POST /robot-link/ingest):
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
