#!/usr/bin/env python3
"""
DRISHTI robot simulator: capture and transmit only.

The simulated rover drives between granite blocks in a quarry, captures RAW
sensor readings at each one (LiDAR extents + point count, an RGB evidence
frame hash, an RTK GNSS fix) and transmits them. It computes nothing about a
block: no volume, gangsaw class, seigniorage or reconciliation. The Portal
(gateway pipeline -> vision -> seigniorage) does all of that; the gateway even
rejects payloads that carry derived values.

Security (drishti_link.py): a per-session AES-256 key from ephemeral ECDH
P-256 + HKDF-SHA256, every message a JWE compact envelope (dir + A256GCM) with
a single-use message id, a sequence number and a timestamp.

Transport:
  * HTTP (default): POST {gateway}/robot-link/ingest
  * AWS IoT Core (--transport aws): publish the same envelopes to
        drishti/robots/{robot_id}/telemetry
        drishti/robots/{robot_id}/captures
    The MQTT client id is the thing name, as aws-iot/iot-policy.json requires.
    The session key is still negotiated with the gateway (HTTPS in production).

Usage:
  pip install cryptography==50.0.1
  python3 sim_agent.py --blocks 6
  python3 sim_agent.py --transport aws --endpoint xxxx-ats.iot.ap-south-1.amazonaws.com \\
      --cert aws-iot/certs/device.pem.crt --key aws-iot/certs/private.pem.key \\
      --ca aws-iot/certs/AmazonRootCA1.pem
"""
import argparse
import hashlib
import math
import os
import random
import sys
import time
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drishti_link import LinkClientError, RobotLink  # noqa: E402

FIRMWARE = "drishti-rover-sim/2.0"
LIDAR_SENSOR = "sim-lidar-360"
_M_PER_DEG = 111_320.0

# Pit centres the rover can be deployed to (its navigation map, not business
# data). Mirrors packages/ui/src/quarries.ts.
SITES = {
    "APQRY-0023": (15.5810, 79.8620), "APQRY-0117": (15.5057, 80.0447),
    "APQRY-0245": (18.2969, 83.8974), "APQRY-0388": (13.2172, 79.1003),
    "APQRY-0451": (14.6819, 77.6006), "APQRY-0512": (16.3067, 80.4365),
    "APQRY-0574": (15.8281, 78.0373), "APQRY-0619": (14.4673, 78.8242),
    "APQRY-0688": (14.4426, 79.9865), "APQRY-0742": (18.1066, 83.3956),
}


def gnss(site, east_m, north_m):
    lat0, lon0 = site
    lat = lat0 + north_m / _M_PER_DEG
    lon = lon0 + east_m / (_M_PER_DEG * math.cos(math.radians(lat0)))
    return {"lat": round(lat, 7), "lon": round(lon, 7),
            "accuracy_m": round(random.uniform(0.02, 0.05), 3), "fix": "RTK_FIXED"}


def raw_capture(quarry_id, block_ref, true_dims, fix, battery):
    """Sensor readings only (schema drishti.robot.capture/v1)."""
    capture_id = str(uuid.uuid4())
    captured_at = datetime.now(timezone.utc).isoformat()
    scan_ms = random.randint(1600, 2200)
    frame_ref = f"frames/{quarry_id}/{block_ref}/{capture_id}.jpg"
    x, y, z = (round(max(0.05, d + random.uniform(-0.02, 0.02)), 3) for d in true_dims)
    return {
        "schema": "drishti.robot.capture/v1",
        "capture_id": capture_id,
        "quarry_id": quarry_id,
        "block_ref": block_ref,
        "captured_at": captured_at,
        "sensor": {
            "lidar": {"extent_x_m": x, "extent_y_m": y, "extent_z_m": z,
                      "point_count": int(48_200 * scan_ms / 1000 * random.uniform(0.9, 1.1)),
                      "scan_ms": scan_ms, "sensor": LIDAR_SENSOR},
            "camera": {"frame_ref": frame_ref,
                       "frame_sha256": hashlib.sha256(f"{frame_ref}|{captured_at}".encode()).hexdigest(),
                       "width_px": 1920, "height_px": 1080},
            "gnss": fix,
        },
        "robot": {"battery_percent": int(battery), "status": "surveying", "firmware": FIRMWARE},
    }


def telemetry(status, battery, fix, waypoint):
    return {"schema": "drishti.robot.telemetry/v1", "status": status,
            "battery_percent": int(battery), "gnss": fix, "waypoint": waypoint[:64]}


class HttpTransport:
    name = "http"

    def __init__(self, link: RobotLink):
        self.link = link

    def send(self, cty, payload):
        return self.link.send(cty, payload)

    def close(self):
        pass


class AwsIotTransport:
    name = "aws-iot"

    def __init__(self, link: RobotLink, robot_id, endpoint, cert, key, ca):
        from awsiot import mqtt_connection_builder
        self.link = link
        self.robot_id = robot_id
        # client_id MUST equal the thing name: the IoT policy only allows
        # client/${iot:Connection.Thing.ThingName}.
        self.conn = mqtt_connection_builder.mtls_from_path(
            endpoint=endpoint, cert_filepath=cert, pri_key_filepath=key, ca_filepath=ca,
            client_id=robot_id, clean_session=True, keep_alive_secs=30,
        )
        self.conn.connect().result()
        print(f"[sim] connected to AWS IoT Core: {endpoint}")

    def send(self, cty, payload):
        from awscrt import mqtt
        topic = f"drishti/robots/{self.robot_id}/{'captures' if cty == 'capture' else 'telemetry'}"
        future, _ = self.conn.publish(topic=topic, payload=self.link.seal(cty, payload),
                                      qos=mqtt.QoS.AT_LEAST_ONCE)
        future.result(timeout=10)
        return {"status": "published", "topic": topic}

    def close(self):
        try:
            self.conn.disconnect().result()
        except Exception:
            pass


def make_transport(args, link):
    mode = args.transport or os.getenv("DRISHTI_IOT_MODE", "http")
    if mode == "aws":
        try:
            return AwsIotTransport(link, args.robot, args.endpoint or os.environ["AWS_IOT_ENDPOINT"],
                                   args.cert or os.environ["AWS_IOT_CERT"],
                                   args.key or os.environ["AWS_IOT_KEY"],
                                   args.ca or os.environ["AWS_IOT_CA"])
        except Exception as e:
            print(f"[sim] AWS IoT unavailable ({e}); falling back to HTTPS/HTTP ingest")
    return HttpTransport(link)


def main():
    ap = argparse.ArgumentParser(description="DRISHTI rover simulator (capture + transmit only)")
    ap.add_argument("--gateway", default=os.getenv("DRISHTI_GATEWAY", "http://localhost:8080"))
    ap.add_argument("--token", default=os.getenv("DRISHTI_ROBOT_TOKEN", "demo.robotop.robot-operator"),
                    help="robot-operator bearer token used to open the link session")
    ap.add_argument("--robot", default="DRISHTI-BOT-01")
    ap.add_argument("--quarry", default="APQRY-0023", choices=sorted(SITES))
    ap.add_argument("--blocks", type=int, default=6, help="number of blocks to capture")
    ap.add_argument("--transport", choices=["http", "aws"], default=None)
    ap.add_argument("--endpoint")
    ap.add_argument("--cert")
    ap.add_argument("--key")
    ap.add_argument("--ca")
    ap.add_argument("--step", type=float, default=0.4, help="seconds between roam steps")
    args = ap.parse_args()

    if not args.gateway.startswith("https://") and "localhost" not in args.gateway and "127.0.0.1" not in args.gateway:
        print("[sim] WARNING: gateway is not HTTPS; the operator token and key exchange would travel unprotected.")

    link = RobotLink(args.gateway, args.robot, args.token)
    try:
        offer = link.open_session()
    except (LinkClientError, OSError) as e:
        sys.exit(f"[sim] could not open a secure link session with {args.gateway}: {e}")
    t = make_transport(args, link)
    site = SITES[args.quarry]
    run = f"S{int(time.time()) % 100000:05d}"
    print(f"[sim] {args.robot} at {args.quarry} via {t.name} · key {offer['kid'][:8]}… "
          f"({offer['kdf']} → {offer['enc']}) · capturing {args.blocks} blocks")

    battery, east, north = 100.0, 0.0, 0.0
    t.send("telemetry", telemetry("surveying", battery, gnss(site, east, north), "leaving dock"))
    for i in range(args.blocks):
        block_ref = f"{args.quarry.replace('APQRY-', 'QRY-')}-{run}-{i:02d}"
        ang = 2 * math.pi * i / max(1, args.blocks) + random.uniform(-0.2, 0.2)
        r = random.uniform(20, 60)
        tx, ty = r * math.cos(ang), r * math.sin(ang)
        for s in range(4):  # roam toward the block, streaming raw position
            east += (tx - east) / (4 - s)
            north += (ty - north) / (4 - s)
            battery = max(5.0, battery - random.uniform(0.4, 0.9))
            t.send("telemetry", telemetry("surveying", battery, gnss(site, east, north), f"-> {block_ref}"))
            time.sleep(args.step)
        dims = (random.uniform(1.4, 3.4), random.uniform(0.8, 2.0), random.uniform(0.5, 1.8))
        cap = raw_capture(args.quarry, block_ref, dims, gnss(site, east, north), battery)
        try:
            ack = t.send("capture", cap)
            print(f"[capture] {block_ref} extents {cap['sensor']['lidar']['extent_x_m']}×"
                  f"{cap['sensor']['lidar']['extent_y_m']}×{cap['sensor']['lidar']['extent_z_m']} m · "
                  f"{ack.get('status')} (seq {ack.get('seq', '-')}) — calculated on the Portal")
        except LinkClientError as e:
            print(f"[error] {block_ref}: {e}")

    t.send("telemetry", telemetry("idle", battery, gnss(site, 0.0, 0.0), "dock"))
    print(f"[sim] {args.robot} survey complete, returned to dock (batt {int(battery)}%)")
    t.close()
    link.close()


if __name__ == "__main__":
    main()
