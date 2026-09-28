#!/usr/bin/env python3
"""
DRISHTI roaming robot simulator.

Simulates the autonomous measurement robot roaming around a quarry: it drives
between granite blocks, streaming position/battery telemetry as it moves, and
publishes a measured block each time it reaches one. The whole system
(telemetry -> console map; block -> measure -> assess -> persist -> dashboards)
comes alive with no hardware.

Transport (auto-selected):
  * AWS IoT Core (MQTT) when --transport aws (or DRISHTI_IOT_MODE=aws) and the
    awsiotsdk + certificates are available. Publishes to:
        drishti/robots/{robot_id}/telemetry
        drishti/robots/{robot_id}/blocks
  * HTTP fallback (default) posts to the gateway:
        POST /robots/{robot_id}/telemetry
        POST /robots/{robot_id}/blocks
    so the roaming demo always works, even offline from AWS.

Usage:
  # HTTP fallback (default, zero setup):
  python3 sim_agent.py --blocks 6

  # AWS IoT Core (free tier). Set endpoint + cert paths, then:
  python3 sim_agent.py --transport aws \
      --endpoint xxxx-ats.iot.ap-south-1.amazonaws.com \
      --cert certs/device.pem.crt --key certs/private.pem.key --ca certs/AmazonRootCA1.pem
"""
import argparse
import json
import math
import os
import random
import time
import urllib.request

# Quarry APQRY-0023 reference (Amravati). Blocks are scattered around this point.
QUARRY_LAT, QUARRY_LON = 16.5734, 80.3567


def _http_post(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


class HttpTransport:
    name = "http"

    def __init__(self, gateway: str, robot_id: str):
        self.gateway = gateway.rstrip("/")
        self.robot_id = robot_id

    def telemetry(self, data: dict):
        _http_post(f"{self.gateway}/robots/{self.robot_id}/telemetry", data)

    def block(self, data: dict):
        return _http_post(f"{self.gateway}/robots/{self.robot_id}/blocks", data)

    def close(self):
        pass


class AwsIotTransport:
    name = "aws-iot"

    def __init__(self, robot_id, endpoint, cert, key, ca):
        from awscrt import mqtt  # noqa: F401
        from awsiot import mqtt_connection_builder
        self.robot_id = robot_id
        self.conn = mqtt_connection_builder.mtls_from_path(
            endpoint=endpoint, cert_filepath=cert, pri_key_filepath=key,
            ca_filepath=ca, client_id=f"drishti-{robot_id}", clean_session=True,
            keep_alive_secs=30,
        )
        self.conn.connect().result()
        print(f"[sim] connected to AWS IoT Core: {endpoint}")

    def _pub(self, suffix, data):
        from awscrt import mqtt
        topic = f"drishti/robots/{self.robot_id}/{suffix}"
        self.conn.publish(topic=topic, payload=json.dumps(data),
                          qos=mqtt.QoS.AT_LEAST_ONCE)

    def telemetry(self, data):
        self._pub("telemetry", data)

    def block(self, data):
        self._pub("blocks", data)
        return {"published": True}

    def close(self):
        try:
            self.conn.disconnect().result()
        except Exception:
            pass


def make_transport(args):
    mode = args.transport or os.getenv("DRISHTI_IOT_MODE", "http")
    if mode == "aws":
        try:
            return AwsIotTransport(args.robot, args.endpoint or os.environ["AWS_IOT_ENDPOINT"],
                                   args.cert or os.environ["AWS_IOT_CERT"],
                                   args.key or os.environ["AWS_IOT_KEY"],
                                   args.ca or os.environ["AWS_IOT_CA"])
        except Exception as e:
            print(f"[sim] AWS IoT unavailable ({e}); falling back to HTTP")
    return HttpTransport(args.gateway, args.robot)


def scatter_blocks(n: int):
    """Generate n block waypoints in a rough ring around the quarry center."""
    pts = []
    for i in range(n):
        ang = (2 * math.pi * i) / n + random.uniform(-0.15, 0.15)
        r = random.uniform(0.0006, 0.0016)  # ~60-180 m
        pts.append((QUARRY_LAT + r * math.sin(ang), QUARRY_LON + r * math.cos(ang)))
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", default="http://localhost:8080")
    ap.add_argument("--robot", default="DRISHTI-BOT-01")
    ap.add_argument("--quarry", default="APQRY-0023")
    ap.add_argument("--blocks", type=int, default=6, help="number of blocks to survey")
    ap.add_argument("--transport", choices=["http", "aws"], default=None)
    ap.add_argument("--endpoint")
    ap.add_argument("--cert")
    ap.add_argument("--key")
    ap.add_argument("--ca")
    ap.add_argument("--step", type=float, default=0.4, help="seconds between roam steps")
    args = ap.parse_args()

    t = make_transport(args)
    print(f"[sim] {args.robot} roaming quarry {args.quarry} via {t.name}, "
          f"surveying {args.blocks} blocks")

    lat, lon = QUARRY_LAT, QUARRY_LON
    battery = 100.0
    waypoints = scatter_blocks(args.blocks)

    def emit_telemetry(status, waypoint):
        t.telemetry({"status": status, "battery_percent": int(battery),
                     "lat": round(lat, 6), "lon": round(lon, 6), "waypoint": waypoint})

    emit_telemetry("surveying", "start")

    for i, (tlat, tlon) in enumerate(waypoints):
        block_id = f"QRY-SIM-{int(time.time())}-{i:03d}"
        # Roam toward the block in a few steps, streaming position.
        for s in range(4):
            lat += (tlat - lat) / (4 - s)
            lon += (tlon - lon) / (4 - s)
            battery = max(5.0, battery - random.uniform(0.4, 0.9))
            emit_telemetry("surveying", f"->{block_id}")
            print(f"[roam] {args.robot} @ ({lat:.5f},{lon:.5f}) batt={int(battery)}%")
            time.sleep(args.step)
        # Reached the block: measure it.
        block = {"block_id": block_id, "quarry_id": args.quarry, "source": "robot",
                 "granite_category": "black_galaxy", "image_ref": f"sim/{block_id}.ply"}
        try:
            res = t.block(block)
            if res.get("volume_m3") is not None:
                print(f"[measured] {block_id} vol={res['volume_m3']}m3 "
                      f"class={res['classification']} fee=Rs{res['seigniorage_fee_inr']}")
            else:
                print(f"[measured] {block_id} published to AWS IoT")
        except Exception as e:
            print(f"[error] {block_id}: {e}")
        emit_telemetry("surveying", f"measured {block_id}")

    # Return to dock.
    emit_telemetry("idle", "dock")
    print(f"[sim] {args.robot} survey complete, returned to dock (batt {int(battery)}%)")
    t.close()


if __name__ == "__main__":
    main()
