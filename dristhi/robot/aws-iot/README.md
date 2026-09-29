# AWS IoT Core for the DRISHTI Roaming Robot (Free Tier)

The measurement robot connects to **AWS IoT Core** over MQTT (mutual TLS). AWS
IoT Core's free tier covers this comfortably: **500,000 messages/month free for
12 months**, plus generous connectivity minutes — a roaming survey publishes on
the order of hundreds of messages, so a demo costs effectively nothing.

## Topic design
```
drishti/robots/{robot_id}/telemetry   # raw position, battery, status
drishti/robots/{robot_id}/captures    # a raw sensor capture of a block
```
Every payload is a sealed JWE envelope from the secure robot link (see
`../README.md`). The robot **publishes**; the gateway IoT bridge **subscribes**
to `drishti/robots/+/telemetry` and `drishti/robots/+/captures`, checks that the
topic's robot id matches the envelope, and runs the Portal-side calculation.

## Least-privilege policies
- `iot-policy.json` (robots): connect only with client id = the thing name the
  certificate is attached to (`${iot:Connection.Thing.ThingName}` +
  `iot:Connection.Thing.IsAttached`), and publish only to that thing's own two
  topics. No subscribe/receive, no wildcards over other robots.
- `iot-bridge-policy.json` (gateway): connect as `drishti-gateway-bridge`,
  subscribe to the two uplink filters, receive only those topics.

`provision.sh` pins both to your account + region before use.

## One-time provisioning (per robot)

You need: the AWS CLI configured, and permission to use IoT. Region example:
`ap-south-1` (Mumbai).

1. **Create the Thing**
   ```bash
   aws iot create-thing --thing-name DRISHTI-BOT-01
   ```

2. **Create certificate + keys**
   ```bash
   aws iot create-keys-and-certificate --set-as-active \
     --certificate-pem-outfile certs/device.pem.crt \
     --public-key-outfile certs/public.pem.key \
     --private-key-outfile certs/private.pem.key
   ```
   Note the returned `certificateArn`.

3. **Download the Amazon Root CA**
   ```bash
   curl -o certs/AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem
   ```

4. **Create + attach the policy** (least-privilege, this folder's `iot-policy.json`;
   replace `arn:aws:iot:*:*:` with your region/account, as `provision.sh` does)
   ```bash
   aws iot create-policy --policy-name DrishtiRobotPolicy \
     --policy-document file://iot-policy.json
   aws iot attach-policy --policy-name DrishtiRobotPolicy --target <certificateArn>
   aws iot attach-thing-principal --thing-name DRISHTI-BOT-01 --principal <certificateArn>
   ```
   Keep `certs/` private (`chmod 600` on the key); it is gitignored.

5. **Get your account's IoT data endpoint**
   ```bash
   aws iot describe-endpoint --endpoint-type iot:Data-ATS
   # -> xxxxxxxx-ats.iot.ap-south-1.amazonaws.com
   ```

> Steps 1-5 are scripted in `provision.sh` (edit the region/robot name first).

## Run the robot against AWS IoT

Robot side (the MQTT client id is the thing name; the session key is still
negotiated with the gateway, so `--gateway` must be reachable, over HTTPS in
production):
```bash
python3 ../sim_agent.py --transport aws --robot DRISHTI-BOT-01 \
  --gateway https://<your-gateway> \
  --endpoint xxxxxxxx-ats.iot.ap-south-1.amazonaws.com \
  --cert certs/device.pem.crt --key certs/private.pem.key --ca certs/AmazonRootCA1.pem \
  --blocks 6
```

Gateway side (so the bridge subscribes and feeds the pipeline). Give the bridge
its **own** certificate with `iot-bridge-policy.json` attached; do not reuse a
robot's certificate:
```bash
export DRISHTI_IOT_MODE=aws
export AWS_IOT_ENDPOINT=xxxxxxxx-ats.iot.ap-south-1.amazonaws.com
export AWS_IOT_CERT=/secure/path/bridge.pem.crt
export AWS_IOT_KEY=/secure/path/bridge.private.pem.key
export AWS_IOT_CA=/secure/path/AmazonRootCA1.pem
export AWS_IOT_CLIENT_ID=drishti-gateway-bridge
# install the optional SDK: pip install awsiotsdk
# then start the gateway (bootstrap.sh picks up the env)
```

Verify in the AWS console: **IoT Core -> Test -> MQTT test client**, subscribe to
`drishti/robots/#`. You will see only ciphertext envelopes; the decrypted raw
payloads appear in the Portal's **Data Transmission** page.

AWS IoT does not guarantee MQTT message order (QoS 1 retries can reorder), so
the gateway accepts sequence numbers inside a 64-message anti-replay window.
A QoS 1 redelivery of an already-accepted envelope is logged as a rejected
replay; the capture itself was stored once.

## No AWS account? Use HTTPS ingest
Omit `--transport aws` and the robot posts the same sealed envelopes to
`POST /robot-link/ingest`. Only the transport differs.

## Previous-project parity
This mirrors the earlier StartupOS robot deployments where a rover roamed around
the blocks publishing to AWS IoT Core — same MQTT topic pattern, same mutual-TLS
device identity, same "telemetry + event" split.
