"""
AWS IoT Core bridge for the DRISHTI measurement robot.

The roaming robot publishes MQTT messages to AWS IoT Core (free tier: 500k
messages/month) on two topics:

    drishti/robots/{robot_id}/telemetry   -> position, battery, status while roaming
    drishti/robots/{robot_id}/blocks      -> a measured granite block

This bridge subscribes to those topics and feeds each message into the gateway
pipeline (telemetry update, or measure -> assess -> persist for a block).

Connectivity modes (auto-selected, most-capable first):
  1. aws  : real AWS IoT Core over mutual-TLS (needs awsiotsdk + certs + endpoint)
  2. off  : bridge disabled (robot can still use the gateway's HTTP fallback)

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

import json
import os
import threading
from typing import Callable

TELEMETRY_TOPIC = "drishti/robots/+/telemetry"
BLOCKS_TOPIC = "drishti/robots/+/blocks"


class IoTBridge:
    def __init__(self, on_telemetry: Callable[[str, dict], None],
                 on_block: Callable[[str, dict], None]):
        self.on_telemetry = on_telemetry
        self.on_block = on_block
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
                data = json.loads(payload.decode())
                robot_id = topic.split("/")[2]
                if topic.endswith("/telemetry"):
                    self.on_telemetry(robot_id, data)
                elif topic.endswith("/blocks"):
                    self.on_block(robot_id, data)
            except Exception as ex:  # pragma: no cover
                print(f"[iot-bridge] handler error on {topic}: {ex}")

        for t in (TELEMETRY_TOPIC, BLOCKS_TOPIC):
            conn.subscribe(topic=t, qos=mqtt.QoS.AT_LEAST_ONCE, callback=handler)[0].result()
            print(f"[iot-bridge] subscribed {t}")
        self._started = True

    def status(self) -> dict:
        return {"mode": self.mode, "connected": self._started}
