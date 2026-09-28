#!/usr/bin/env bash
#
# DRISHTI end-to-end smoke test. Exercises the full pipeline against a running
# gateway and asserts expected results. Exits non-zero on any failure.
#
set -uo pipefail

GW="${GATEWAY:-http://localhost:8080}"
PASS=0; FAIL=0
check() { # desc, actual, expected-substring
  if echo "$2" | grep -q "$3"; then echo "  PASS: $1"; PASS=$((PASS+1));
  else echo "  FAIL: $1 (got: $2)"; FAIL=$((FAIL+1)); fi
}

echo "== Health =="
check "gateway health"     "$(curl -s $GW/health)"       '"status":"ok"'
check "vision health"      "$(curl -s http://localhost:8001/health)"  '"status":"ok"'
check "seigniorage health" "$(curl -s http://localhost:8002/health)"  '"status":"ok"'
check "omeps health"       "$(curl -s http://localhost:8003/health)"  '"status":"ok"'

echo "== Capture pipeline (measure -> assess -> persist) =="
CAP=$(curl -s -X POST $GW/captures -H 'Content-Type: application/json' \
  -d '{"block_id":"QRY-SMOKE-001","quarry_id":"APQRY-0023","source":"robot","granite_category":"black_galaxy"}')
check "capture returns volume"        "$CAP" '"volume_m3"'
check "capture returns classification" "$CAP" '"classification"'
check "capture returns fee"           "$CAP" '"seigniorage_fee_inr"'
check "capture pending"               "$CAP" '"status":"pending"'

echo "== RBAC =="
OFFICER=$(curl -s -X POST $GW/blocks/QRY-SMOKE-001/approve -H 'Authorization: Bearer demo.officer.officer')
check "officer can approve" "$OFFICER" '"status":"approved"'
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST $GW/blocks/QRY-SMOKE-001/flag -H 'Authorization: Bearer demo.operator.operator')
check "operator forbidden (403)" "$CODE" '403'

echo "== OMEPS cross-validation (anomaly) =="
SYNC=$(curl -s -X POST "$GW/omeps/sync/QRY-SMOKE-001?weighbridge_weight_mt=6.4" -H 'Authorization: Bearer demo.officer.officer')
check "omeps sync responds" "$SYNC" '"synced":true'

echo "== Analytics =="
check "analytics summary" "$(curl -s $GW/analytics/summary)" '"total"'

echo "== Robots =="
check "list robots"  "$(curl -s $GW/robots)" 'DRISHTI-BOT-01'
SURV=$(curl -s -X POST $GW/robots/DRISHTI-BOT-01/survey -H 'Authorization: Bearer demo.robotop.robot-operator')
check "start survey" "$SURV" '"status":"surveying"'

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
