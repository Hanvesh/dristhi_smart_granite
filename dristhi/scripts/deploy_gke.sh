#!/usr/bin/env bash
#
# DRISHTI -> Google Kubernetes Engine (Autopilot).
#
# Idempotent, safe to re-run. Creates what is missing (APIs, node service
# account, Artifact Registry repo, global static IP, Cloud Endpoints DNS names,
# Autopilot cluster), then builds + pushes every image and applies infra/k8s.
#
# Usage:
#   ./scripts/deploy_gke.sh            # provision (if needed) + build + push + deploy
#   ./scripts/deploy_gke.sh --status   # URLs, pods, ingress + certificate status
#
# Config (env overrides):
#   PROJECT_ID=dhristi-rtgs-demo  REGION=asia-south1  CLUSTER=drishti-demo-gke
#   AR_REPO=drishti  STATIC_IP_NAME=drishti-demo-ip  TAG=<git-sha>-<utc timestamp>
#
# Public URLs follow the Google Cloud naming convention for project-scoped DNS,
# <name>.endpoints.<PROJECT_ID>.cloud.goog, with names drishti-<app>:
#   https://drishti-portal.endpoints.<PROJECT_ID>.cloud.goog   Portal (UI #1)
#   https://drishti-robot.endpoints.<PROJECT_ID>.cloud.goog    Robot Console (UI #2)
#   https://drishti-api.endpoints.<PROJECT_ID>.cloud.goog      Gateway API (/docs)
#
# Requires: gcloud (authenticated, with gke-gcloud-auth-plugin), kubectl, docker, envsubst.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ID="${PROJECT_ID:-dhristi-rtgs-demo}"
REGION="${REGION:-asia-south1}"
CLUSTER="${CLUSTER:-drishti-demo-gke}"
AR_REPO="${AR_REPO:-drishti}"
STATIC_IP_NAME="${STATIC_IP_NAME:-drishti-demo-ip}"
NODE_SA_NAME="${NODE_SA_NAME:-drishti-gke-nodes}"
NAMESPACE=drishti
POSTGIS_IMAGE="postgis/postgis:16-3.4"

REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
TAG="${TAG:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)-$(date -u +%Y%m%d%H%M%S)}"
DOMAIN_SUFFIX="endpoints.${PROJECT_ID}.cloud.goog"
PORTAL_HOST="drishti-portal.${DOMAIN_SUFFIX}"
ROBOT_HOST="drishti-robot.${DOMAIN_SUFFIX}"
API_HOST="drishti-api.${DOMAIN_SUFFIX}"
NODE_SA="${NODE_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export REGISTRY TAG PORTAL_HOST ROBOT_HOST API_HOST STATIC_IP_NAME

log() { printf "\033[1;34m[deploy]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[deploy]\033[0m %s\n" "$*" >&2; exit 1; }
gc() { gcloud --project "$PROJECT_ID" --quiet "$@"; }
kc() { kubectl --namespace "$NAMESPACE" "$@"; }
retry() { # retry <attempts> <cmd...>  (IAM changes on a new service account take a moment to propagate)
  local n="$1" i; shift
  for ((i = 1; i <= n; i++)); do "$@" && return 0; sleep 10; done
  return 1
}
# Substitute only our own variables, so shell snippets inside manifests stay intact.
render() { envsubst '${REGISTRY} ${TAG} ${PORTAL_HOST} ${ROBOT_HOST} ${API_HOST} ${STATIC_IP_NAME}' < "$1"; }

print_urls() {
  cat <<EOF

  Portal (UI #1):         https://${PORTAL_HOST}   (officer/officer, operator/operator, admin-user/admin)
  Robot Console (UI #2):  https://${ROBOT_HOST}    (robotop/robotop)
  Gateway API docs:       https://${API_HOST}/docs
EOF
}

status() {
  gc container clusters get-credentials "$CLUSTER" --region "$REGION" >/dev/null 2>&1 || die "cluster $CLUSTER not found"
  log "Pods"; kc get pods -o wide
  log "Ingress"; kc get ingress drishti
  log "Managed certificate"
  kc get managedcertificate drishti-demo-cert \
    -o jsonpath='{.status.certificateStatus}{"  "}{range .status.domainStatus[*]}{.domain}={.status}{" "}{end}{"\n"}'
  print_urls
}

if [ "${1:-}" = "--status" ]; then status; exit 0; fi

# 0) Preconditions -----------------------------------------------------------
for bin in gcloud kubectl docker envsubst gke-gcloud-auth-plugin; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool: $bin"
done
[ -n "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ] \
  || die "gcloud is not authenticated; run: gcloud auth login"
log "Project ${PROJECT_ID}, region ${REGION}, cluster ${CLUSTER}, image tag ${TAG}"

# 1) APIs --------------------------------------------------------------------
log "Enabling required APIs (no-op when already enabled)..."
gc services enable container.googleapis.com artifactregistry.googleapis.com compute.googleapis.com \
  iam.googleapis.com servicemanagement.googleapis.com servicecontrol.googleapis.com endpoints.googleapis.com

# 2) Least-privilege node service account ------------------------------------
if ! gc iam service-accounts describe "$NODE_SA" >/dev/null 2>&1; then
  log "Creating node service account ${NODE_SA}"
  gc iam service-accounts create "$NODE_SA_NAME" --display-name "DRISHTI GKE nodes"
fi
retry 6 gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${NODE_SA}" \
  --role roles/container.defaultNodeServiceAccount --condition None >/dev/null

# 3) Artifact Registry --------------------------------------------------------
if ! gc artifacts repositories describe "$AR_REPO" --location "$REGION" >/dev/null 2>&1; then
  log "Creating Artifact Registry repo ${AR_REPO} (${REGION})"
  gc artifacts repositories create "$AR_REPO" --location "$REGION" --repository-format docker \
    --description "DRISHTI container images"
fi
retry 6 gc artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$REGION" \
  --member "serviceAccount:${NODE_SA}" --role roles/artifactregistry.reader >/dev/null

# 4) Static IP + Cloud Endpoints DNS ------------------------------------------
if ! gc compute addresses describe "$STATIC_IP_NAME" --global >/dev/null 2>&1; then
  log "Reserving global static IP ${STATIC_IP_NAME}"
  gc compute addresses create "$STATIC_IP_NAME" --global --ip-version IPV4
fi
LB_IP="$(gc compute addresses describe "$STATIC_IP_NAME" --global --format='value(address)')"
log "Load balancer IP: ${LB_IP}"

deploy_dns() { # host title
  local host="$1" title="$2" current spec
  current="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  if [ "$current" = "$LB_IP" ]; then log "DNS ${host} -> ${LB_IP} (ok)"; return; fi
  log "Publishing DNS ${host} -> ${LB_IP} (Cloud Endpoints)"
  spec="$(mktemp --suffix=.yaml)"
  HOST="$host" IP="$LB_IP" TITLE="$title" envsubst '${HOST} ${IP} ${TITLE}' \
    < "$ROOT/infra/gcp/endpoints-dns.yaml" > "$spec"
  gc endpoints services deploy "$spec" >/dev/null
  rm -f "$spec"
}
deploy_dns "$PORTAL_HOST" "DRISHTI Portal"
deploy_dns "$ROBOT_HOST" "DRISHTI Robot Console"
deploy_dns "$API_HOST" "DRISHTI Gateway API"

# 5) GKE Autopilot cluster ----------------------------------------------------
if ! gc container clusters describe "$CLUSTER" --region "$REGION" >/dev/null 2>&1; then
  log "Creating GKE Autopilot cluster ${CLUSTER} in ${REGION} (takes ~10 minutes)..."
  gc container clusters create-auto "$CLUSTER" --region "$REGION" \
    --release-channel regular --service-account "$NODE_SA"
fi
gc container clusters get-credentials "$CLUSTER" --region "$REGION"

# 6) Images -------------------------------------------------------------------
log "Building and pushing images to ${REGISTRY} ..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null 2>&1
build_push() { # name context [docker build args...]
  local name="$1" ctx="$2"; shift 2
  log "  ${name}:${TAG}"
  docker build --platform linux/amd64 -q -t "${REGISTRY}/${name}:${TAG}" "$@" "$ctx" >/dev/null
  docker push -q "${REGISTRY}/${name}:${TAG}" >/dev/null
}
build_push gateway       "$ROOT/services/gateway"
build_push vision        "$ROOT/services/vision"
build_push seigniorage   "$ROOT/services/seigniorage"
build_push omeps-adapter "$ROOT/services/omeps-adapter"
build_push portal        "$ROOT" -f "$ROOT/infra/docker/web.Dockerfile" \
  --build-arg APP=portal --build-arg "VITE_ROBOT_CONSOLE_URL=https://${ROBOT_HOST}"
build_push robot-console "$ROOT" -f "$ROOT/infra/docker/web.Dockerfile" \
  --build-arg APP=robot-console --build-arg "VITE_PORTAL_URL=https://${PORTAL_HOST}"
# Mirror PostGIS into Artifact Registry (no Docker Hub pulls/rate limits at runtime).
log "  postgis:16-3.4 (mirror of ${POSTGIS_IMAGE})"
docker pull --platform linux/amd64 -q "$POSTGIS_IMAGE" >/dev/null
docker tag "$POSTGIS_IMAGE" "${REGISTRY}/postgis:16-3.4"
docker push -q "${REGISTRY}/postgis:16-3.4" >/dev/null

# 7) Kubernetes ---------------------------------------------------------------
log "Applying manifests..."
render "$ROOT/infra/k8s/00-namespace.yaml" | kubectl apply -f -
if ! kc get secret drishti-db >/dev/null 2>&1; then
  log "Creating database credentials (Secret drishti-db, generated once)"
  DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  kc create secret generic drishti-db \
    --from-literal=POSTGRES_USER=dristhi \
    --from-literal=POSTGRES_DB=dristhi \
    --from-literal=POSTGRES_PASSWORD="$DB_PASSWORD" \
    --from-literal=DATABASE_URL="postgresql://dristhi:${DB_PASSWORD}@postgres:5432/dristhi"
  unset DB_PASSWORD
fi
kc create configmap drishti-db-init --from-file="$ROOT/infra/init/db" --dry-run=client -o yaml | kubectl apply -f -
for f in "$ROOT"/infra/k8s/[1-9]*.yaml; do render "$f" | kubectl apply -f -; done

log "Waiting for rollouts (first run includes Autopilot node provisioning)..."
kc rollout status statefulset/postgres --timeout=20m
for d in vision seigniorage omeps gateway portal robot-console; do
  kc rollout status "deployment/${d}" --timeout=20m
done

log "Deployed ${TAG}."
kc get managedcertificate drishti-demo-cert -o jsonpath='{"  TLS certificate: "}{.status.certificateStatus}{"\n"}' || true
echo "  (A new Google-managed certificate takes ~15-60 min to become Active; check with --status.)"
print_urls
