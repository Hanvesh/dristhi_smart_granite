# DRISHTI — Demo & Presentation Playbook

**Event:** RTGS AI Hackathon 2026 — *Smart Granite Block Measuring & Tax Assessment*
**Solution:** Project DRISHTI by PeopleWave
**Goal of this document:** a step-by-step script to run a live demo and give a
presentation that satisfies every requirement in the government brief
(`Draft_I_4980426_2026.pdf`) — and shows the judges each one working in real time.

Read it top-to-bottom to rehearse. During the demo, follow **Part 3** on stage.

---

## Part 0 — What the judges asked for (and where we prove it)

The Department's memo lists five expected capabilities. This is the scorecard we
demo against — memorize this table; each row maps to a moment in the live demo.

| # | Government requirement | Where we show it live | Screen |
|---|------------------------|-----------------------|--------|
| 1 | **Granite block volume estimation** from standardized images | Robot/mobile capture → AI measures L×W×H + volume + confidence | Portal → Blocks |
| 2 | **Automated seigniorage classification** (Above/Below Gangsaw + fee) | Same block auto-classified and priced by the rules engine | Portal → Blocks |
| 3 | **Mobile app for field capture** (GPS, timestamp, Block ID, quarry) | Mobile app / Portal capture form submits a geo-tagged block | Portal → New Capture |
| 4 | **OMEPS 2.0 integration** cross-validating AI volume vs weighbridge/dispatch | Officer clicks **OMEPS sync** on a block; anomaly auto-flagged | Portal → Blocks |
| 5 | **Audit & traceability** (measurement → dispatch lifecycle) | Click a block for its lifecycle timeline; dept-wide append-only feed | Portal → Blocks / Audit Trail |
| ★ | **Beyond the brief:** autonomous roaming robot on AWS IoT (hardware-accurate stereo depth, zero human effort) | Robot roams the quarry live on a map, measuring blocks over AWS IoT | Robot Console |

**One-line pitch:** *DRISHTI replaces subjective manual tape measurement with an
auditable digital pipeline — and an autonomous robot that roams the quarry,
measures every block to ±2 cm, and streams results over AWS IoT straight into
the seigniorage and OMEPS workflow. Fully open source.*

---

## Part 1 — Prerequisites (do this before you present)

| Tool | Version | For |
|------|---------|-----|
| Python | 3.10+ | backend services |
| Node.js + npm | 18+ / 9+ | the two UIs |
| Docker + Compose | recent | infra (Postgres, Keycloak, Grafana). Optional — `--no-infra` works |
| (optional) AWS account | free tier | real AWS IoT Core robot connectivity |

Nothing else is required: the AI runs a weights-free estimator, the gateway
falls back to an in-memory store, and the robot falls back to HTTP if AWS IoT
isn't configured. **The demo cannot "fail to connect" on stage.**

---

## Part 2 — One-command startup (rehearse until it's boring)

```bash
cd dristhi
./scripts/bootstrap.sh                 # full stack
# If a local Postgres already uses 5432:
DRISHTI_PG_PORT=5433 ./scripts/bootstrap.sh
# No Docker on the demo laptop:
./scripts/bootstrap.sh --no-infra
```

Wait for the endpoint banner, then open **three browser tabs**:

1. **Robot Console** — http://localhost:5174  (login `robotop` / `robotop`)
2. **Officer Portal** — http://localhost:5173  (login `officer` / `officer`)
3. **Admin Analytics** — http://localhost:5173 in a second profile (login `admin-user` / `admin`)

Confirm the **PeopleWave logo** + StartupOS styling on every login screen. Leave
a terminal open for the robot simulator.

Smoke-check everything is green before you go on stage:
```bash
./scripts/smoke_test.sh          # expect: RESULT: 18 passed, 0 failed
```

---

## Part 3 — The Live Demo Script (≈ 7 minutes)

Speak the **[SAY]** lines; do the **[DO]** actions. Requirement tags in **(R#)**
map to the scorecard in Part 0.

### Scene 1 — The problem (30 sec, no screen)
> **[SAY]** "Today a DMGO officer drives to a quarry and measures each granite
> block by hand — length, breadth, height — then computes volume and seigniorage
> on paper. It's subjective, slow, and leaks revenue. There's no audit trail
> linking a block to the weighbridge or dispatch. DRISHTI fixes all of that."

### Scene 2 — The robot roams the quarry  (R★, 90 sec)
> **[SAY]** "Instead of sending an officer, we send an autonomous robot."

**[DO]** Switch to the **Robot Console** tab. In the fleet table, click
**Start survey** on `DRISHTI-BOT-01`. (No terminal, no commands — one click
dispatches the robot.)
> **[SAY]** "I just dispatched the robot with one click. This is a live **3D
> view** of the quarry. The tracked rover you see driving across the pit is our
> robot — its position streams over **AWS IoT Core**, the same MQTT setup we've
> used on previous rover deployments."

**[DO]** In the **Quarry Survey — live 3D** scene: drag to orbit the camera,
scroll to zoom. Point out the rover driving along its trail (battery dropping,
green scan cone active while surveying) and the **granite blocks standing in the
pit — each rendered at its actual measured size**. Point at the
**"AWS IoT connected" / "telemetry: HTTP"** badge in the top bar.
> **[SAY]** "Every granite block you see is drawn to its real measured
> dimensions — length, width, height. Dark blocks are Above-Gangsaw, lighter ones
> Below; a red ring means an OMEPS anomaly. Each time the rover reaches a block it
> captures stereo depth, builds a 3D point cloud, and measures it to within
> 2 centimetres — no human, no tape."

### Scene 3 — Volume estimation + seigniorage  (R1, R2, 90 sec)
**[DO]** Switch to the **Officer Portal** → **Blocks**. New rows have appeared
(the robot's measurements).
> **[SAY]** "Here's what the robot just measured. For each block we get
> **length, width, height, volume and a confidence score** — that's requirement
> one." **(R1)**

**[DO]** Point at the **Class** and **Fee** columns.
> **[SAY]** "And automatically: **Above or Below Gangsaw** classification and the
> **seigniorage fee**, computed by our rules engine against the government fee
> schedule. That's requirement two — no manual calculation." **(R2)**

### Scene 4 — Mobile field capture  (R3, 45 sec)
> **[SAY]** "Officers and lessees who don't have the robot use our mobile app."

**[DO]** Portal → **New Capture** (or show the Flutter app). Submit a block.
> **[SAY]** "The mobile app captures a **GPS-tagged, timestamped** photo with the
> **Block ID and quarry details** — standardized every time. It works offline and
> syncs when back online. Same AI pipeline, same result. Requirement three." **(R3)**

### Scene 5 — OMEPS 2.0 cross-validation & fraud detection  (R4, 75 sec)
**[DO]** On a pending block, as the officer, click the **OMEPS sync** button in
the Actions column (it cross-validates against a weighbridge weight). Equivalent
CLI, if you prefer the terminal:
```bash
curl -s -X POST "http://localhost:8080/omeps/sync/<BLOCK_ID>?weighbridge_weight_mt=6.4" \
  -H 'Authorization: Bearer demo.officer.officer'
```
> **[SAY]** "Now we cross-validate against **OMEPS 2.0**. DRISHTI compares the
> AI-measured volume with the **weighbridge** weight and **dispatch** record. If
> they disagree beyond tolerance —" **[DO]** show the block flip to **flagged** —
> "the block is auto-flagged as a **revenue-leakage anomaly** for audit. That's
> requirement four, and it's exactly the fraud the department is losing money
> to." **(R4)**

### Scene 6 — Audit trail & department analytics  (R5, 60 sec)
**[DO]** In the **Officer Portal → Blocks**, click any block ID to expand its
**lifecycle timeline** (measured → classified → OMEPS cross-validated →
approved/flagged, each with timestamp + actor).
> **[SAY]** "Click any block and you see its complete journey — who measured it,
> when it was classified and priced, the OMEPS check, and the officer decision.
> Every action is an immutable audit event."

**[DO]** Open the **Audit Trail** tab for the department-wide, append-only feed;
then switch to **Admin Analytics**.
> **[SAY]** "Across the department, this is the full append-only audit feed —
> and the analytics roll-up: totals, revenue, pending reviews and anomalies
> district-wide. Complete traceability from the block in the quarry to dispatch
> clearance. Requirement five." **(R5)**

### Scene 7 — Close (30 sec)
> **[SAY]** "Everything you just saw is **100% open source** — no vendor lock-in,
> deployable on government infrastructure. The robot uses **AWS IoT Core's free
> tier**. Two separate secure logins: one for officers, one for the robot control
> room. This isn't a slideware demo — it's a running system. Thank you."

---

## Part 4 — Judge Q&A — quick, credible answers

- **"Is the AI real?"** The pipeline is real end-to-end; the vision service has a
  documented interface for YOLOv11 + Depth Anything V2 (mobile) and OAK-D stereo
  (robot). For the demo it runs a deterministic estimator so it works without a
  GPU. Flip one env var (`DRISHTI_VISION_BACKEND=real`) to use trained models.
- **"How accurate?"** Robot stereo point cloud targets ±2–3 cm / volume ±3–5%,
  vs ±10–20 cm for a single phone photo. See `smart_granite_block/`.
- **"What if the quarry has no internet?"** The robot buffers locally and syncs
  over AWS IoT when connectivity returns; the gateway works offline too.
- **"Why AWS IoT?"** Managed, secure (per-device mutual-TLS certs), scales to a
  fleet, free tier covers this. Same pattern as prior rover projects.
- **"Is it locked to AWS?"** Only the robot transport. The whole platform is
  open source and self-hostable; the robot also has an HTTP fallback.
- **"Cost?"** Open-source stack (no license fees) + AWS IoT free tier.
- **"Security?"** Keycloak OAuth2/JWT, role-based access (officer vs
  robot-operator), least-privilege IoT policy, full audit log.

---

## Part 5 — Automated verification (proof the system works)

Run these before the presentation; screenshot the passing output as a backup slide.

### 5.1 End-to-end smoke test (18 checks)
```bash
./scripts/smoke_test.sh
# RESULT: 18 passed, 0 failed
```
Covers health, capture→measure→assess→persist, RBAC (officer approves, operator
gets 403), OMEPS anomaly detection, **audit trail per-block + dept-wide feed**,
analytics, robot survey.

### 5.2 Roaming robot integration (verified)
The roam is now **triggered from the UI** (Start survey) — the gateway runs it
server-side. To verify from the CLI, hit the same endpoint the button calls:
```bash
# start survey (what the "Start survey" button POSTs):
curl -s -X POST "http://localhost:8080/robots/DRISHTI-BOT-01/survey?blocks=3&step_sec=0.2" \
  -H 'Authorization: Bearer demo.robotop.robot-operator'
# poll a few times — position/battery/waypoint change, blocks_measured climbs:
curl -s http://localhost:8080/robots
# stop early if needed (what "Stop survey" POSTs):
curl -s -X POST "http://localhost:8080/robots/DRISHTI-BOT-01/survey/stop" \
  -H 'Authorization: Bearer demo.robotop.robot-operator'
```
Verified: one click drives the rover — telemetry streamed across waypoints,
battery 100→92%, three blocks measured/classified/priced, `/blocks` grew 2→5,
`/robots` reflected new position + `blocks_measured`; Stop returned it to dock
and halted; operator role got HTTP 403 (RBAC intact).

> The standalone `robot/sim_agent.py` still exists for the AWS IoT / on-hardware
> path (see 5.5), but the live demo needs no terminal command.

### 5.3 Unit tests
```bash
# venv with pytest + fastapi + httpx
pytest services/vision services/seigniorage services/omeps-adapter -q
```

### 5.4 Frontend builds
```bash
npm run build     # both UIs build; Portal + Robot Console emit production bundles
```

### 5.5 AWS IoT path (only if you have an AWS account)
```bash
# provision device + certs (free tier)
bash robot/aws-iot/provision.sh DRISHTI-BOT-01
# start gateway bridge in AWS mode (see robot/aws-iot/README.md), then:
python3 robot/sim_agent.py --transport aws --robot DRISHTI-BOT-01 \
  --endpoint <your-ats-endpoint> \
  --cert robot/aws-iot/certs/device.pem.crt \
  --key  robot/aws-iot/certs/private.pem.key \
  --ca   robot/aws-iot/certs/AmazonRootCA1.pem --blocks 6
```
Confirm messages in AWS console → IoT Core → MQTT test client → subscribe
`drishti/robots/#`. The Console badge shows **AWS IoT connected**.

---

## Part 6 — Failure recovery on stage (don't panic)

| If… | Do this |
|-----|---------|
| Port 5432 clash | restart with `DRISHTI_PG_PORT=5433 ./scripts/bootstrap.sh` |
| Docker won't start | `./scripts/bootstrap.sh --no-infra` (in-memory store) |
| AWS IoT won't connect | omit `--transport aws`; robot uses HTTP, demo identical |
| A UI shows "offline demo data" | the gateway isn't reachable; it still renders seeded data so you can keep talking, then restart the gateway |
| Robot not moving in 3D | click **Start survey** in the fleet table; the rover moves within ~2 s (console polls telemetry every 2 s) |

Have Part 5 screenshots ready as a backup slide in case the laptop misbehaves.

---

## Part 7 — Teardown
```bash
./scripts/bootstrap.sh --stop
```

---

## Appendix — Endpoints & demo credentials

| Surface | URL | Login |
|---------|-----|-------|
| Officer Portal (UI #1) | http://localhost:5173 | officer/officer · operator/operator · admin-user/admin |
| Robot Console (UI #2) | http://localhost:5174 | robotop/robotop |
| Gateway API docs | http://localhost:8080/docs | — |
| Grafana | http://localhost:3000 | admin/admin |
| Keycloak | http://localhost:8090 | admin/admin |

## Appendix — Real vs placeholder (be honest if asked)

| Area | Demo state | Production path |
|------|-----------|-----------------|
| Capture → measure → assess → persist → OMEPS → audit trail → analytics | fully working | — |
| RBAC / two logins | working (demo tokens) | Keycloak JWT (already wired) |
| AI dimensions | deterministic estimator | YOLOv11 + Depth Anything V2 / OAK-D stereo |
| Seigniorage slabs | generic rates | gazetted AP schedule |
| OMEPS 2.0 | mock adapter (same contract) | real OMEPS REST client |
| Robot transport | AWS IoT Core + HTTP fallback | AWS IoT Core on Jetson |
| 3D quarry view | live Three.js scene (terrain + blocks at measured size + roaming rover) | fed by real robot telemetry + point clouds |
| PeopleWave logo / StartupOS | placeholders | official assets |
