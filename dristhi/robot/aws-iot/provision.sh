#!/usr/bin/env bash
#
# Provision an AWS IoT Core Thing + certificate + policy for a DRISHTI robot.
# Free-tier friendly. Requires the AWS CLI configured with IoT permissions.
#
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
ROBOT="${1:-DRISHTI-BOT-01}"
POLICY="DrishtiRobotPolicy"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$HERE/certs"
mkdir -p "$CERTS"

echo "Region: $REGION   Robot: $ROBOT"

aws iot create-thing --region "$REGION" --thing-name "$ROBOT" >/dev/null
echo "Thing created."

CERT_ARN=$(aws iot create-keys-and-certificate --region "$REGION" --set-as-active \
  --certificate-pem-outfile "$CERTS/device.pem.crt" \
  --public-key-outfile "$CERTS/public.pem.key" \
  --private-key-outfile "$CERTS/private.pem.key" \
  --query certificateArn --output text)
echo "Certificate: $CERT_ARN"

curl -s -o "$CERTS/AmazonRootCA1.pem" https://www.amazontrust.com/repository/AmazonRootCA1.pem
echo "Root CA downloaded."

aws iot create-policy --region "$REGION" --policy-name "$POLICY" \
  --policy-document "file://$HERE/iot-policy.json" 2>/dev/null || echo "(policy exists)"
aws iot attach-policy --region "$REGION" --policy-name "$POLICY" --target "$CERT_ARN"
aws iot attach-thing-principal --region "$REGION" --thing-name "$ROBOT" --principal "$CERT_ARN"
echo "Policy attached."

ENDPOINT=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)
echo
echo "Done. IoT endpoint: $ENDPOINT"
echo
echo "Run the robot:"
echo "  python3 $HERE/../sim_agent.py --transport aws --robot $ROBOT \\"
echo "    --endpoint $ENDPOINT \\"
echo "    --cert $CERTS/device.pem.crt --key $CERTS/private.pem.key --ca $CERTS/AmazonRootCA1.pem --blocks 6"
