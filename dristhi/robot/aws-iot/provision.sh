#!/usr/bin/env bash
#
# Provision an AWS IoT Core Thing + certificate + least-privilege policy for a
# DRISHTI robot. Free-tier friendly. Requires the AWS CLI with IoT permissions.
#
# The robot policy (iot-policy.json) lets a certificate connect ONLY as the
# thing it is attached to (client id == thing name) and publish ONLY to
# drishti/robots/<thing>/{telemetry,captures}. Robots cannot subscribe or
# receive. The gateway bridge gets its own policy (iot-bridge-policy.json).
#
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
ROBOT="${1:-DRISHTI-BOT-01}"
POLICY="DrishtiRobotPolicy"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$HERE/certs"
mkdir -p "$CERTS"
chmod 700 "$CERTS"

if ! [[ "$ROBOT" =~ ^[A-Z0-9][A-Z0-9-]{2,47}$ ]]; then
  echo "Robot id must match ^[A-Z0-9][A-Z0-9-]{2,47}$ (same rule the gateway enforces)" >&2
  exit 1
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Region: $REGION   Account: $ACCOUNT   Robot: $ROBOT"

# Pin the policy to this account + region (the checked-in file uses wildcards).
render() { sed -e "s/arn:aws:iot:\*:\*:/arn:aws:iot:${REGION}:${ACCOUNT}:/g" "$1" > "$2"; }
render "$HERE/iot-policy.json" "$CERTS/iot-policy.rendered.json"

aws iot create-thing --region "$REGION" --thing-name "$ROBOT" >/dev/null
echo "Thing created."

CERT_ARN=$(aws iot create-keys-and-certificate --region "$REGION" --set-as-active \
  --certificate-pem-outfile "$CERTS/device.pem.crt" \
  --public-key-outfile "$CERTS/public.pem.key" \
  --private-key-outfile "$CERTS/private.pem.key" \
  --query certificateArn --output text)
chmod 600 "$CERTS/private.pem.key"
echo "Certificate: $CERT_ARN"

curl -fsS -o "$CERTS/AmazonRootCA1.pem" https://www.amazontrust.com/repository/AmazonRootCA1.pem
echo "Root CA downloaded."

if aws iot get-policy --region "$REGION" --policy-name "$POLICY" >/dev/null 2>&1; then
  # Existing (possibly older, broader) policy: make the least-privilege
  # document the default version rather than silently keeping the old one.
  aws iot create-policy-version --region "$REGION" --policy-name "$POLICY" \
    --policy-document "file://$CERTS/iot-policy.rendered.json" --set-as-default >/dev/null \
    || { echo "Could not add a policy version (AWS keeps max 5). Delete an old version of $POLICY and re-run." >&2; exit 1; }
  echo "Policy $POLICY updated to the least-privilege version."
else
  aws iot create-policy --region "$REGION" --policy-name "$POLICY" \
    --policy-document "file://$CERTS/iot-policy.rendered.json" >/dev/null
  echo "Policy $POLICY created."
fi
aws iot attach-policy --region "$REGION" --policy-name "$POLICY" --target "$CERT_ARN"
aws iot attach-thing-principal --region "$REGION" --thing-name "$ROBOT" --principal "$CERT_ARN"
echo "Policy attached."

ENDPOINT=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)
render "$HERE/iot-bridge-policy.json" "$CERTS/iot-bridge-policy.rendered.json"
echo
echo "Done. IoT endpoint: $ENDPOINT"
echo "Gateway bridge policy (attach to the bridge's own certificate): $CERTS/iot-bridge-policy.rendered.json"
echo
echo "Run the robot (MQTT client id = thing name; the session key is negotiated with the gateway):"
echo "  python3 $HERE/../sim_agent.py --transport aws --robot $ROBOT \\"
echo "    --gateway https://<your-gateway> \\"
echo "    --endpoint $ENDPOINT \\"
echo "    --cert $CERTS/device.pem.crt --key $CERTS/private.pem.key --ca $CERTS/AmazonRootCA1.pem --blocks 6"
