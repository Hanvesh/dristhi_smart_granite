# Project DRISHTI — Smart Granite Block Measuring & Tax Assessment

AI-based solution for automated granite block measurement, seigniorage
assessment, and integration with OMEPS 2.0, built for the RTGS AI Hackathon 2026
(Government of Andhra Pradesh, Department of Mines & Geology). Submitted by
**PeopleWave**.

Everything is **open source** and self-hostable.

## Repository layout

```
.
├─ Draft_I_4980426_2026.pdf     # Government hackathon brief
├─ PROJECT_PLAN.md              # Full step-by-step project plan
├─ smart_granite_block/         # Proposal + Edge AI robot design docs
└─ dristhi/                     # The implementation (monorepo)
   ├─ apps/                     # UI #1 Officer Portal, UI #2 Robot Console, mobile app
   ├─ packages/ui/              # Shared StartupOS design system + PeopleWave logo
   ├─ services/                 # gateway, vision, seigniorage, omeps-adapter
   ├─ robot/                    # Roaming robot sim + AWS IoT Core setup
   ├─ infra/                    # docker-compose (Postgres/PostGIS, Keycloak, Grafana...)
   ├─ scripts/                  # bootstrap.sh (from-scratch startup), smoke_test.sh
   ├─ README.md                 # Implementation README
   └─ TESTING_PLAN.md           # Demo / presentation playbook
```

## Quick start

```bash
cd dristhi
./scripts/bootstrap.sh
```

See `dristhi/README.md` for details and `dristhi/TESTING_PLAN.md` for the demo
walkthrough.

## Highlights

- Two separate UIs (Officer/Operator Portal and a live **3D** Robot Operations
  Console) on a shared StartupOS design system with the PeopleWave logo.
- Autonomous quarry-measurement robot that roams in 3D, recharges at its home
  dock, and streams telemetry + measured blocks over **AWS IoT Core** (free tier).
- Real Andhra Pradesh granite quarries, granite blocks rendered at their
  measured dimensions, automated seigniorage classification, and OMEPS 2.0
  cross-validation with anomaly flagging.
