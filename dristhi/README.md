# Project DRISHTI

AI-Based Granite Block Measurement, Seigniorage Assessment & OMEPS 2.0 Integration.

Built entirely on **open-source** components. See `../PROJECT_PLAN.md` for the full plan
and `TESTING_PLAN.md` for how to run and verify everything from scratch.

## Monorepo Layout

```
dristhi/
├─ apps/
│  ├─ portal/            # UI #1  User/Officer Portal (React + Vite + TS)
│  ├─ robot-console/     # UI #2  Robot Ops Console (React + Vite + TS, live 3D quarry via Three.js)
│  └─ mobile/            # Flutter field app (scaffold)
├─ packages/
│  └─ ui/                # shared StartupOS design tokens + <BrandLogo/> (PeopleWave)
├─ services/
│  ├─ gateway/           # Spring Boot 3 (Java 21) API gateway
│  ├─ vision/            # FastAPI + YOLOv11/Depth placeholders + OpenCV geometry
│  ├─ seigniorage/       # FastAPI seigniorage rules engine
│  └─ omeps-adapter/     # FastAPI OMEPS 2.0 integration adapter
├─ robot/                # Roaming robot: sim + AWS IoT Core (aws-iot/) setup
├─ infra/
│  ├─ docker-compose.yml # postgres+postgis, minio, keycloak, prometheus, grafana, loki
│  └─ ...
└─ scripts/
   └─ bootstrap.sh       # start everything from scratch
```

## Quick Start

```bash
cd dristhi
./scripts/bootstrap.sh
```

Then open:
- Portal (UI #1):        http://localhost:5173
- Robot Console (UI #2): http://localhost:5174
- Gateway API docs:      http://localhost:8080/swagger-ui.html
- Vision API docs:       http://localhost:8001/docs
- Seigniorage API docs:  http://localhost:8002/docs
- OMEPS Adapter docs:    http://localhost:8003/docs
- MinIO console:         http://localhost:9001  (optional; see below)
- Keycloak:              http://localhost:8090
- Grafana:               http://localhost:3000

## Infra notes (image availability & ports)

- **MinIO is optional.** Some networks cannot pull the MinIO images anonymously
  (Docker Hub `minio/minio` is gated; the quay.io mirror needs auth). So MinIO
  lives behind a Docker Compose profile and is **skipped by default**. The
  backend uses a local-filesystem evidence store when MinIO is absent, so the
  full pipeline still runs. To enable MinIO where its images are pullable:
  ```bash
  cd infra && docker compose --profile storage up -d
  ```
- **Postgres host port is configurable** to avoid clashing with a local
  Postgres already on 5432. Override with `DRISHTI_PG_PORT`:
  ```bash
  DRISHTI_PG_PORT=5433 ./scripts/bootstrap.sh
  ```

## Notes on placeholders

Where real assets/specs are not available, generic placeholders are used and clearly marked:
- **PeopleWave logo**: an inline SVG placeholder in `packages/ui`. Drop the real PNG/SVG in to replace.
- **StartupOS design system**: a self-contained token set approximating the brand palette from the proposal.
- **AI models (YOLOv11 / Depth Anything V2)**: the vision service ships a deterministic mock estimator so the full pipeline runs without GPUs/model weights. Swap in real models via the documented interface.
- **AP seigniorage fee schedule**: generic slab values in `services/seigniorage/rules.py`.
- **OMEPS 2.0 API**: mocked endpoints in `services/omeps-adapter`.
- **Robot connectivity (AWS IoT Core)**: the roaming robot publishes telemetry
  + measured blocks over MQTT to AWS IoT Core (free tier). Provisioning is in
  `robot/aws-iot/`. With no AWS account, the robot falls back to HTTP so the
  roaming demo still works — see `robot/README.md`.
```
