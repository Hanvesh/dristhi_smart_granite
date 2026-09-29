"""
AWS IoT Core bridge for the DRISHTI measurement robot.

The robot publishes MQTT messages to AWS IoT Core (free tier: 500k
messages/month) on two topics:

    drishti/robots/{robot_id}/telemetry   -> raw position/battery/status
    drishti/robots/{robot_id}/captures    -> a raw sensor capture of a block

Every payload is a JWE compact envelope from the secure robot link (the same
bytes the robot would POST to /robot-link/ingest). The bridge does not parse
it: it hands the raw bytes plus the topic's robot id to the gateway, which
verifies the envelope, checks that the id matches the envelope's device, and
runs the portal-side calculation pipeline. The per-thing IoT policy
(robot/aws-iot/iot-policy.json) pins each robot to its own topics.

Connectivity modes (auto-selected, most-capable first):
  1. aws  : real AWS IoT Core over mutual-TLS (needs awsiotsdk + certs + endpoint)
  2. off  : bridge disabled (robot posts the same envelopes to /robot-link/ingest)

Enable AWS mode by setting these env vars (see robot/aws-iot/README.md):
    DRISHTI_IOT_MODE=aws
    AWS_IOT_ENDPOINT=xxxxx-ats.iot.ap-south-1.amazonaws.com
    AWS_IOT_CERT=/path/device.pem.crt
    AWS_IOT_KEY=/path/private.pem.key
    AWS_IOT_CA=/path/AmazonRootCA1.pem
    AWS_IOT_CLIENT_ID=drishti-gateway-bridge

The bridge runs in a background thread started from the gateway lifespan.
"""
from __future__ import annotations

import os
import threading
from typing import Callable

TELEMETRY_TOPIC = "drishti/robots/+/telemetry"
CAPTURES_TOPIC = "drishti/robots/+/captures"


class IoTBridge:
    def __init__(self, on_envelope: Callable[[str, bytes], None]):
        self.on_envelope = on_envelope
        self.mode = os.getenv("DRISHTI_IOT_MODE", "off").lower()
        self._conn = None
        self._thread: threading.Thread | None = None
        self._started = False

    # ---- lifecycle ----
    def start(self):
        if self.mode != "aws":
            print(f"[iot-bridge] mode={self.mode} (AWS IoT disabled; robot uses HTTP fallback)")
            return
        self._thread = threading.Thread(target=self._run_aws, daemon=True)
        self._thread.start()

    def _run_aws(self):
        try:
            from awscrt import mqtt
            from awsiot import mqtt_connection_builder
        except Exception as e:  # pragma: no cover
            print(f"[iot-bridge] awsiotsdk not installed ({e}); disabling AWS mode")
            self.mode = "off"
            return

        endpoint = os.environ["AWS_IOT_ENDPOINT"]
        cert = os.environ["AWS_IOT_CERT"]
        key = os.environ["AWS_IOT_KEY"]
        ca = os.environ["AWS_IOT_CA"]
        client_id = os.getenv("AWS_IOT_CLIENT_ID", "drishti-gateway-bridge")

        conn = mqtt_connection_builder.mtls_from_path(
            endpoint=endpoint, cert_filepath=cert, pri_key_filepath=key,
            ca_filepath=ca, client_id=client_id, clean_session=False, keep_alive_secs=30,
        )
        conn.connect().result()
        self._conn = conn
        print(f"[iot-bridge] connected to AWS IoT Core at {endpoint}")

        def handler(topic, payload, **_):
            try:
                parts = topic.split("/")
                if len(parts) != 4 or parts[:2] != ["drishti", "robots"] or parts[3] not in ("telemetry", "captures"):
                    return
                self.on_envelope(parts[2], bytes(payload))
            except Exception as ex:  # pragma: no cover
                print(f"[iot-bridge] handler error on {topic}: {ex}")

        for t in (TELEMETRY_TOPIC, CAPTURES_TOPIC):
            conn.subscribe(topic=t, qos=mqtt.QoS.AT_LEAST_ONCE, callback=handler)[0].result()
            print(f"[iot-bridge] subscribed {t}")
        self._started = True

    def status(self) -> dict:
        return {"mode": self.mode, "connected": self._started}
