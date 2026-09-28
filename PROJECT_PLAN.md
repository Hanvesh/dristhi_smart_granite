# Project DRISHTI — Step-by-Step Project Plan

**AI-Based Granite Block Measurement, Seigniorage Assessment & OMEPS 2.0 Integration**
Prepared for the RTGS AI Hackathon 2026 (Govt. of Andhra Pradesh, Dept. of Mines & Geology)
Submitted by PeopleWave

---

## 0. How to Read This Plan

This plan does three things:

1. **Verifies** that the two existing documents in `smart_granite_block/` satisfy the government requirement in `Draft_I_4980426_2026.pdf`.
2. **Re-architects** the solution so that **every component is open source** (no AWS S3 / AWS ECS lock-in, no proprietary services).
3. **Splits the front-end into two separate UIs** — one for **user login / officer & operator workflows**, one for **robot fleet operations** — both built on the **StartupOS design system** with the **PeopleWave logo** present.

---

## 1. Requirement Coverage Check

The government memo (`Draft_I_4980426_2026.pdf`) defines five expected capabilities. The table maps each to the existing proposal and the robot doc, and flags gaps this plan closes.

| # | Govt. Requirement | Covered by PeopleWave Proposal (`.tex`) | Covered by Robot Doc | Gap this plan closes |
|---|-------------------|----------------------------------------|---------------------|----------------------|
| 1 | Granite block volume estimation from mobile images | Yes — YOLOv11 + Depth Anything V2 + geometric analysis | Yes — OAK-D stereo point cloud (higher accuracy) | Keep both paths; make models the open-source variants |
| 2 | Automated seigniorage classification | Yes — rules engine, Above/Below Gangsaw | Yes — same engine on-device | None |
| 3 | Mobile app (GPS, timestamp, Block ID, quarry details, standardized capture) | Yes — Flutter app | Robot replaces manual capture | Keep mobile app; add offline sync |
| 4 | OMEPS 2.0 integration (cross-validate AI volume / weighbridge / dispatch) | Yes — REST APIs | Yes — same API | None |
| 5 | Audit & traceability (measurement → transport → dispatch) | Yes — governance platform | Yes — evidence payload per block | None |

**Conclusion:** The combined proposals **fully satisfy** the government requirement. Two things must change to meet *your* constraints:

- **Open-source only** — the proposal used Amazon S3 + AWS ECS. These are replaced (see Section 3).
- **Two separate UIs** — the proposal implied a single dashboard. This plan splits it (see Section 4).

---

## 2. Target Architecture (Open Source Only)

```
                    ┌──────────────────────────────────────────────┐
                    │  FIELD / EDGE LAYER                            │
                    │                                                │
   Officers &       │  ┌──────────────┐      ┌────────────────────┐ │
   Operators  ─────▶│  │ Mobile App   │      │ DRISHTI Robot      │ │
   (phones)         │  │ (Flutter)    │      │ Jetson + OAK-D Pro │ │
                    │  │ GPS+timestamp│      │ YOLOv11 + stereo   │ │
                    │  └──────┬───────┘      └─────────┬──────────┘ │
                    └─────────┼────────────────────────┼────────────┘
                              │  (REST / mTLS, offline-tolerant)
                              ▼                         ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  BACKEND (self-hosted, open source)                            │
   │  ┌────────────┐  ┌─────────────┐  ┌────────────────────────┐   │
   │  │ API Gateway│  │ AI Vision   │  │ Seigniorage Rules      │   │
   │  │ Spring Boot│─▶│ Service     │─▶│ Engine                 │   │
   │  │ (Java 21)  │  │ (FastAPI +  │  │ (Java, Drools optional)│   │
   │  │ Keycloak   │  │  Ultralytics)│ └────────────────────────┘   │
   │  │ OAuth2/JWT │  └─────────────┘                               │
   │  └─────┬──────┘         │                                      │
   │        │        ┌───────▼────────┐   ┌──────────────────────┐  │
   │        │        │ MinIO          │   │ PostgreSQL + PostGIS  │  │
   │        │        │ (S3-compatible │   │ (blocks, fees, audit) │  │
   │        │        │  object store) │   └──────────────────────┘  │
   │        │        └────────────────┘                             │
   │        ▼                                                       │
   │  ┌──────────────┐   ┌────────────────────────────────────┐    │
   │  │ OMEPS 2.0    │   │ Observability: Prometheus + Grafana │    │
   │  │ Integration  │   │ + Loki (logs)                       │    │
   │  └──────────────┘   └────────────────────────────────────┘    │
   └───────────────────────────────────────────────────────────────┘
                              ▲                         ▲
                              │                         │
        ┌─────────────────────┴──────┐   ┌──────────────┴───────────────┐
        │  UI #1: User / Officer      │   │  UI #2: Robot Operations      │
        │  Portal (login, review,     │   │  Console (fleet, live feed,   │
        │  seigniorage, audit)        │   │  survey control, telemetry)   │
        │  StartupOS design + PW logo │   │  StartupOS design + PW logo   │
        └─────────────────────────────┘   └───────────────────────────────┘
```

---

## 3. Open-Source Technology Stack

Every proprietary/managed service from the original proposal is replaced with a self-hostable open-source equivalent.

| Layer | Original (proposal) | Open-Source Replacement | License |
|-------|--------------------|-----------------------|---------|
| Object storage | Amazon S3 | **MinIO** (S3-compatible) | AGPL-3.0 |
| Container orchestration | AWS ECS | **Docker + Docker Compose** (dev) / **Kubernetes (K3s)** (prod) | Apache-2.0 |
| Identity / login | (unspecified JWT) | **Keycloak** (OAuth2, OIDC, JWT, RBAC) | Apache-2.0 |
| Backend API | Java 21 + Spring Boot 3 | **Same** (both open source) | Apache-2.0 |
| AI serving | (implied cloud) | **FastAPI** + **Ultralytics YOLOv11** + **Depth Anything V2** + **OpenCV** | AGPL/Apache/BSD |
| Database | PostgreSQL | **PostgreSQL + PostGIS** (geospatial block mapping) | PostgreSQL License |
| Monitoring | Prometheus + Grafana | **Same** + **Loki** for logs | Apache-2.0 |
| Mobile app | Flutter | **Same** (BSD) | BSD-3 |
| User & Robot UIs | (single dashboard) | **React + Vite + TypeScript**, StartupOS design system | MIT |
| Rules engine | custom | Custom Java (optionally **Drools**) | Apache-2.0 |
| Message/queue (robot sync) | — | **NATS** or **Redis** (open source editions) | Apache/BSD |

**Note:** MinIO is AGPL-3.0. For the hackathon and government self-hosted deployment this is fine. If AGPL is a concern for redistribution, **SeaweedFS (Apache-2.0)** is the drop-in alternative.

---

## 4. The Two Separate UIs

Both UIs are separate applications (separate routes, separate builds, separate auth scopes) sharing one component library so the StartupOS look-and-feel and the PeopleWave logo are identical across both.

### UI #1 — User / Officer Portal  (`apps/portal`)
Audience: DMGO officers, quarry operators, mining department admins.

- **Login screen** (Keycloak-backed) — PeopleWave logo centered, StartupOS styling.
- Role-based dashboards:
  - **Operator:** submit block captures, view AI-estimated dimensions + indicative fee.
  - **DMGO Officer:** review AI measurements vs photo evidence, approve high-confidence (>90%), flag low-confidence.
  - **Department Admin:** district/quarry analytics, weighbridge vs AI anomaly view, audit trail, OMEPS sync status.
- Block lifecycle view: measurement → classification → fee → dispatch.

### UI #2 — Robot Operations Console  (`apps/robot-console`)
Audience: field robot operators / control room.

- **Separate login** (robot-operator role scope in Keycloak).
- Fleet overview: each robot's battery, GPS, status, blocks/hour.
- Live survey control: start/stop autonomous survey, waypoint map (PostGIS), live RGB + depth stream.
- Per-block review: point cloud viewer, dimensions, confidence, evidence images.
- Telemetry & alerts: connectivity, offline-buffer status, low-confidence flags.

### Shared design foundation (`packages/ui`)
- **StartupOS design system** for all tokens (color, spacing, typography), buttons, tables, cards, form controls.
- **PeopleWave logo** as a shared `<BrandLogo />` component rendered in every top nav + login screen of **both** UIs.
- Single source of truth so both apps stay visually consistent.

> Action item: the file `../peoplewave-logo.png` referenced by the LaTeX proposal is **not present** in the workspace, and no StartupOS design assets were found. Both must be supplied before UI build starts (see Section 7, Phase 0).

---

## 5. Repository Structure

```
dristhi/
├─ apps/
│  ├─ portal/            # UI #1  (React + Vite + TS, StartupOS)
│  ├─ robot-console/     # UI #2  (React + Vite + TS, StartupOS)
│  └─ mobile/            # Flutter field app
├─ packages/
│  ├─ ui/                # shared StartupOS component lib + <BrandLogo/>
│  └─ api-client/        # generated TS client from OpenAPI
├─ services/
│  ├─ gateway/           # Spring Boot 3 (Java 21) API gateway + Keycloak
│  ├─ vision/            # FastAPI + YOLOv11 + Depth Anything V2 + OpenCV
│  ├─ seigniorage/       # rules engine (Java)
│  └─ omeps-adapter/     # OMEPS 2.0 integration
├─ robot/                # Jetson edge stack (ROS2, OAK-D pipeline)
├─ infra/
│  ├─ docker-compose.yml # local: minio, postgres+postgis, keycloak, grafana
│  └─ k3s/               # production manifests
└─ docs/
```

---

## 6. Data Model & API (core)

**Per-block record** (PostgreSQL + PostGIS), aligned to the robot doc's JSON payload:
`block_id, quarry_id, timestamp, gps(point), length_m, width_m, height_m, volume_m3, confidence, method, classification, seigniorage_fee_inr, evidence_refs (MinIO keys), source (mobile|robot), audit_events[]`

**Key REST endpoints (OpenAPI, served by gateway):**
- `POST /captures` — mobile/robot submit measurement + evidence
- `GET /blocks/{id}` — full lifecycle + evidence
- `POST /blocks/{id}/approve` — officer approval
- `GET /analytics/*` — district/quarry dashboards
- `POST /omeps/sync` — cross-validate volume/weighbridge/dispatch
- `GET /robots`, `POST /robots/{id}/survey` — robot console

All secured via Keycloak (OAuth2/OIDC), role scopes: `operator`, `officer`, `admin`, `robot-operator`.

---

## 7. Step-by-Step Delivery Roadmap

### Phase 0 — Foundations (Week 1)
- [ ] Obtain **PeopleWave logo** asset and **StartupOS design system** tokens/assets (currently missing).
- [ ] Scaffold monorepo (`apps/`, `packages/`, `services/`, `infra/`).
- [ ] Stand up `infra/docker-compose.yml`: PostgreSQL+PostGIS, MinIO, Keycloak, Prometheus/Grafana/Loki.
- [ ] Configure Keycloak realm + roles (`operator`, `officer`, `admin`, `robot-operator`).

### Phase 1 — Shared UI + Auth (Week 2)
- [ ] Build `packages/ui` from StartupOS design system; add `<BrandLogo/>` (PeopleWave).
- [ ] Implement Keycloak login flow shared by both UIs.
- [ ] Login screens for **UI #1** and **UI #2** with PeopleWave logo + StartupOS styling.

### Phase 2 — AI Vision Service (Weeks 3–4)
- [ ] `services/vision` (FastAPI): YOLOv11 detection/segmentation, Depth Anything V2, OpenCV geometry.
- [ ] Volume + confidence output; store evidence in MinIO.
- [ ] Unit + accuracy tests against a labeled sample set.

### Phase 3 — Backend, Seigniorage & Persistence (Weeks 4–5)
- [ ] `services/gateway` (Spring Boot 3) with OpenAPI + Keycloak security.
- [ ] `services/seigniorage` rules engine (Above/Below Gangsaw, AP fee schedule).
- [ ] PostgreSQL+PostGIS schema + audit trail.

### Phase 4 — UI #1 User/Officer Portal (Weeks 5–6)
- [ ] Operator, Officer, Admin dashboards; block lifecycle & analytics views.
- [ ] Anomaly view (AI vs weighbridge).

### Phase 5 — Mobile Field App (Weeks 6–7)
- [ ] Flutter: GPS-tagged, timestamped, Block-ID + quarry capture, standardized guidance.
- [ ] Offline capture + secure sync to gateway.

### Phase 6 — Robot Edge Stack + UI #2 (Weeks 7–9)
- [ ] `robot/` Jetson stack: OAK-D stereo → point cloud → dimensions; ROS2 navigation.
- [ ] Robot → backend sync (NATS/Redis, offline-tolerant).
- [ ] UI #2 Robot Console: fleet, live feed, survey control, point-cloud review.

### Phase 7 — OMEPS 2.0 Integration & Audit (Week 9)
- [ ] `services/omeps-adapter`: cross-validate AI volume / weighbridge / dispatch.
- [ ] End-to-end audit traceability (measurement → transport → dispatch).

### Phase 8 — Field Validation & Hardening (Weeks 10–11)
- [ ] Real-quarry pilot; compare AI/robot vs manual measurements.
- [ ] Observability dashboards, security review, deploy to K3s.

---

## 8. Success Metrics (from govt. requirement + proposal)

- Dimension accuracy > 95% (mobile) / > 98% (robot), within 2–5 cm.
- Volume accuracy > 90% (mobile) / > 97% (robot point cloud).
- AI confidence > 85% for 80%+ of blocks.
- Physical inspection reduced by ≥ 70%.
- Processing time < 30 s (mobile upload→result); < 60 s (robot multi-view).
- OMEPS 2.0 sync 100%; complete digital audit trail.

---

## 9. Open Items / Assumptions

1. **PeopleWave logo** (`peoplewave-logo.png`) is referenced by the proposal but not in the workspace — needed before UI work.
2. **StartupOS design system** assets/tokens not found in the workspace — needed for `packages/ui`.
3. AP government seigniorage fee schedule (slab values) must be provided to finalize the rules engine.
4. OMEPS 2.0 API spec/credentials required for the integration adapter.
5. MinIO (AGPL-3.0) chosen for object storage; switch to SeaweedFS (Apache-2.0) if AGPL redistribution is a concern.
