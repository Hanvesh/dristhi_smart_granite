import React, { useEffect, useState } from "react";
import { Card, Badge } from "@drishti/ui";
import { api, AuditEvent } from "../api";

// Demo fallback so the traceability story still renders if the gateway is down.
const DEMO_AUDIT: AuditEvent[] = [
  { block_id: "QRY-AMR-2026-0100", event_type: "approved", actor: "officer", detail: {}, created_at: new Date(Date.now() - 3 * 60000).toISOString() },
  { block_id: "QRY-AMR-2026-0100", event_type: "omeps_synced", actor: "officer", detail: { anomaly: false, message: "Synced to OMEPS 2.0" }, created_at: new Date(Date.now() - 4 * 60000).toISOString() },
  { block_id: "QRY-AMR-2026-0100", event_type: "classified", actor: "seigniorage-engine", detail: { class: "below_gangsaw", fee_inr: 4560 }, created_at: new Date(Date.now() - 5 * 60000).toISOString() },
  { block_id: "QRY-AMR-2026-0100", event_type: "measured", actor: "DRISHTI-BOT-01", detail: { method: "robot_stereo_pointcloud", confidence: 0.94 }, created_at: new Date(Date.now() - 6 * 60000).toISOString() },
];

const EVENT_META: Record<string, { label: string; color: string; icon: string }> = {
  measured: { label: "Measured", color: "var(--sos-blue)", icon: "M" },
  classified: { label: "Classified", color: "#7b61ff", icon: "C" },
  omeps_synced: { label: "OMEPS cross-validated", color: "#0a9396", icon: "O" },
  approved: { label: "Approved", color: "var(--sos-success)", icon: "A" },
  flagged: { label: "Flagged (anomaly)", color: "var(--sos-danger)", icon: "!" },
  rejected: { label: "Rejected", color: "var(--sos-danger)", icon: "R" },
  transmitted: { label: "Transmitted (secure robot link)", color: "#5b3fd1", icon: "T" },
  calculation_warning: { label: "Calculation warning", color: "#B26A00", icon: "W" },
  survey_started: { label: "Survey started", color: "var(--sos-blue)", icon: "S" },
  survey_stopped: { label: "Survey stopped", color: "var(--sos-text-muted)", icon: "S" },
};

function meta(type: string) {
  return EVENT_META[type] ?? { label: type, color: "var(--sos-text-muted)", icon: "•" };
}

function fmt(ts: string) {
  try {
    return new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return ts;
  }
}

function detailText(d: Record<string, unknown>) {
  const keys = Object.keys(d ?? {});
  if (!keys.length) return null;
  return keys.map((k) => `${k}: ${String(d[k])}`).join(" · ");
}

/** Compact vertical timeline for one block's lifecycle. */
export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <p style={{ color: "var(--sos-text-muted)" }}>No audit events yet.</p>;
  return (
    <div style={{ display: "grid", gap: 0 }}>
      {events.map((e, i) => {
        const m = meta(e.event_type);
        const last = i === events.length - 1;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{
                width: 24, height: 24, borderRadius: "50%", background: m.color, color: "#fff",
                display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
              }}>{m.icon}</span>
              {!last && <span style={{ width: 2, flex: 1, background: "var(--sos-border)", minHeight: 18 }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 16 }}>
              <div style={{ fontWeight: 600, color: "var(--sos-text)" }}>{m.label}</div>
              <div style={{ fontSize: 12, color: "var(--sos-text-muted)" }}>
                {fmt(e.created_at)} · by {e.actor}
              </div>
              {detailText(e.detail) && (
                <div style={{ fontSize: 12, color: "var(--sos-text-muted)", marginTop: 2 }}>{detailText(e.detail)}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Department-wide audit feed (full page). */
export function AuditView() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState("");

  const load = async () => {
    try {
      setEvents(await api.auditFeed(200));
      setLive(true);
    } catch {
      setEvents(DEMO_AUDIT);
      setLive(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const filtered = filter
    ? events.filter((e) => e.block_id.toLowerCase().includes(filter.toLowerCase()) || e.event_type.includes(filter.toLowerCase()))
    : events;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Audit & Traceability</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!live && <Badge tone="warning">offline demo data</Badge>}
          <input
            placeholder="Filter by block ID or event…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius-sm)", fontSize: 13, minWidth: 240 }}
          />
        </div>
      </div>
      <p style={{ margin: 0, color: "var(--sos-text-muted)", fontSize: 13 }}>
        Immutable, append-only record of every block's journey: measurement → seigniorage classification →
        OMEPS 2.0 cross-validation → officer approval/flag → dispatch. Full digital traceability from quarry to dispatch.
      </p>
      <Card>
        <div style={{ display: "grid", gap: 4 }}>
          {filtered.map((e, i) => {
            const m = meta(e.event_type);
            return (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "150px 180px 1fr 200px", gap: 12, alignItems: "center",
                padding: "8px 4px", borderBottom: "1px solid var(--sos-border)", fontSize: 13,
              }}>
                <code style={{ fontSize: 12 }}>{e.block_id}</code>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: m.color }} />
                  {m.label}
                </span>
                <span style={{ color: "var(--sos-text-muted)" }}>{detailText(e.detail) ?? "—"}</span>
                <span style={{ color: "var(--sos-text-muted)", textAlign: "right" }}>{fmt(e.created_at)} · {e.actor}</span>
              </div>
            );
          })}
          {!filtered.length && <p style={{ color: "var(--sos-text-muted)" }}>No matching audit events.</p>}
        </div>
      </Card>
    </div>
  );
}
