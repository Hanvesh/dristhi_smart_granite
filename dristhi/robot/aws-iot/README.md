# AWS IoT Core for the DRISHTI Roaming Robot (Free Tier)

The measurement robot connects to **AWS IoT Core** over MQTT (mutual TLS). AWS
IoT Core's free tier covers this comfortably: **500,000 messages/month free for
12 months**, plus generous connectivity minutes — a roaming survey publishes on
the order of hundreds of messages, so a demo costs effectively nothing.

## Topic design
```
drishti/robots/{robot_id}/telemetry   # position, battery, status (streamed while roaming)
drishti/robots/{robot_id}/blocks      # a measured granite block (measure->assess->persist)
```
The robot **publishes**; the gateway IoT bridge **subscribes** to both wildcard
topics (`drishti/robots/+/telemetry`, `drishti/robots/+/blocks`).

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

4. **Create + attach the policy** (least-privilege, this folder's `iot-policy.json`)
   ```bash
   aws iot create-policy --policy-name DrishtiRobotPolicy \
     --policy-document file://iot-policy.json
   aws iot attach-policy --policy-name DrishtiRobotPolicy --target <certificateArn>
   aws iot attach-thing-principal --thing-name DRISHTI-BOT-01 --principal <certificateArn>
   ```

5. **Get your account's IoT data endpoint**
   ```bash
   aws iot describe-endpoint --endpoint-type iot:Data-ATS
   # -> xxxxxxxx-ats.iot.ap-south-1.amazonaws.com
   ```

> Steps 1-5 are scripted in `provision.sh` (edit the region/robot name first).

## Run the robot against AWS IoT

Robot side:
```bash
python3 ../sim_agent.py --transport aws --robot DRISHTI-BOT-01 \
  --endpoint xxxxxxxx-ats.iot.ap-south-1.amazonaws.com \
  --cert certs/device.pem.crt --key certs/private.pem.key --ca certs/AmazonRootCA1.pem \
  --blocks 6
```

Gateway side (so the bridge subscribes and feeds the pipeline):
```bash
export DRISHTI_IOT_MODE=aws
export AWS_IOT_ENDPOINT=xxxxxxxx-ats.iot.ap-south-1.amazonaws.com
export AWS_IOT_CERT=$PWD/robot/aws-iot/certs/device.pem.crt
export AWS_IOT_KEY=$PWD/robot/aws-iot/certs/private.pem.key
export AWS_IOT_CA=$PWD/robot/aws-iot/certs/AmazonRootCA1.pem
# install the optional SDK: pip install awsiotsdk
# then start the gateway (bootstrap.sh picks up the env)
```

Verify in the AWS console: **IoT Core -> Test -> MQTT test client**, subscribe to
`drishti/robots/#`, and watch the telemetry + block messages flow while the robot
roams.

## No AWS account? Use the HTTP fallback
Everything works without AWS: omit `--transport aws` and the robot posts the same
telemetry + block payloads straight to the gateway. The demo (roaming map, live
measurements, dashboards) is identical; only the transport differs.

## Previous-project parity
This mirrors the earlier StartupOS robot deployments where a rover roamed around
the blocks publishing to AWS IoT Core — same MQTT topic pattern, same mutual-TLS
device identity, same "telemetry + event" split.
