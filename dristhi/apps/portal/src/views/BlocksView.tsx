import React, { useEffect, useState } from "react";
import { Card, Table, Button, Badge, inr, inrExact, seigniorageBreakdown, classificationLabel, omepsCrossCheck } from "@drishti/ui";
import type { OmepsResult } from "@drishti/ui";
import { Link } from "react-router-dom";
import { api, ApiError, Block, AuditEvent } from "../api";
import { DEMO_BLOCKS } from "../demoData";
import { AuditTimeline } from "./AuditView";
import type { Role } from "../auth";

const toneFor = (status: string) =>
  status === "approved" ? "success" : status === "flagged" || status === "rejected" ? "danger" : "warning";

export function BlocksView({ role }: { role: Role }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [live, setLive] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Last OMEPS cross-validation result, shown inline as a banner so the officer
  // gets clear feedback (online result from the gateway, or offline computed).
  const [omeps, setOmeps] = useState<(OmepsResult & { block_id: string; offline: boolean }) | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    try {
      setBlocks(await api.listBlocks());
      setLive(true);
    } catch {
      setBlocks(DEMO_BLOCKS);
      setLive(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openTrace = async (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setAudit([]);
    try {
      setAudit(await api.blockAudit(id));
    } catch {
      setAudit([]);
    }
  };

  const act = async (id: string, action: "approve" | "flag") => {
    setActionError(null);
    try {
      if (action === "approve") await api.approve(id);
      else await api.flag(id);
      await load();
      if (openId === id) setAudit(await api.blockAudit(id));
    } catch (e) {
      if (e instanceof ApiError) {
        // The gateway refused (e.g. a justification note is required): say so,
        // never pretend it worked.
        setActionError(`${id}: ${e.detail || `HTTP ${e.status}`}`);
        return;
      }
      // Gateway unreachable: reflect the action locally for the offline demo.
      setBlocks((b) => b.map((x) => (x.block_id === id ? { ...x, status: action === "approve" ? "approved" : "flagged" } : x)));
    }
  };

  const runOmeps = async (id: string) => {
    setBusy(id);
    // A deliberately low weighbridge weight to demo anomaly detection.
    const weight = 6.4;
    try {
      // Online: let the gateway + omeps-adapter do the cross-validation.
      const res = await api.omepsSync(id, weight);
      setOmeps({ ...res, block_id: id, offline: false });
      await load();
      if (openId === id) setAudit(await api.blockAudit(id));
    } catch {
      // Offline (or block not on server): compute the SAME cross-validation
      // locally so the officer still sees a result instead of a silent no-op.
      const b = blocks.find((x) => x.block_id === id);
      const res = omepsCrossCheck(b?.volume_m3 ?? 0, weight);
      setOmeps({ ...res, block_id: id, offline: true });
      // Reflect an anomaly as a flag in the local view.
      if (res.anomaly) {
        setBlocks((bs) => bs.map((x) => (x.block_id === id ? { ...x, status: "flagged" } : x)));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Block Measurements</h2>
        {!live && <Badge tone="warning">offline demo data (gateway not reachable)</Badge>}
      </div>

      {actionError && (
        <div role="alert" style={{ marginBottom: 16, borderRadius: 8, padding: "10px 14px", fontSize: 13, border: "1px solid var(--sos-danger)", background: "rgba(198,40,40,0.07)", color: "var(--sos-danger)" }}>
          {actionError} · <Link to="/approvals">Open Approvals</Link> to decide with a note.
        </div>
      )}

      {omeps && (
        <div
          style={{
            marginBottom: 16, borderRadius: 8, padding: "10px 14px", fontSize: 13,
            border: `1px solid ${omeps.anomaly ? "var(--sos-danger)" : "#0a9396"}`,
            background: omeps.anomaly ? "rgba(255,77,79,0.08)" : "rgba(10,147,150,0.08)",
            display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
          }}
        >
          <span>
            <b>OMEPS 2.0 {omeps.anomaly ? "anomaly" : "cross-validated"}</b> · {omeps.block_id}
            {" — "}{omeps.message}
            {omeps.weighbridge_volume_m3 != null && ` · weighbridge ${omeps.weighbridge_volume_m3} m³`}
            {omeps.divergence != null && ` · divergence ${(omeps.divergence * 100).toFixed(1)}%`}
            {omeps.offline && <span style={{ color: "var(--sos-text-muted)" }}> · offline check</span>}
          </span>
          <button
            onClick={() => setOmeps(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--sos-text-muted)", fontSize: 16, lineHeight: 1 }}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}
      <Table
        columns={["Block ID", "Quarry", "L×W×H (m)", "Volume", "Tonnage", "Class", "Conf.", "Fee (INR)", "Status", "Actions"]}
        rows={blocks.map((b) => [
          <button
            onClick={() => openTrace(b.block_id)}
            style={{ background: "none", border: "none", color: "var(--sos-blue)", cursor: "pointer", fontWeight: 600, padding: 0, fontSize: 13 }}
            title="View lifecycle / audit trail"
          >
            {openId === b.block_id ? "▾ " : "▸ "}{b.block_id}
          </button>,
          b.quarry_id,
          `${b.length_m} × ${b.width_m} × ${b.height_m}`,
          `${b.volume_m3} m³`,
          b.tonnage_mt != null ? `${b.tonnage_mt} MT` : "—",
          classificationLabel(b.classification),
          `${Math.round(b.confidence * 100)}%`,
          inr(b.seigniorage_fee_inr),
          <Badge tone={toneFor(b.status)}>{b.status}</Badge>,
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {role !== "operator" && (
              <Button variant="ghost" onClick={() => runOmeps(b.block_id)} disabled={busy === b.block_id}>
                {busy === b.block_id ? "Syncing…" : "OMEPS sync"}
              </Button>
            )}
            {b.status === "pending" && role !== "operator" && (
              <>
                <Button variant="success" onClick={() => act(b.block_id, "approve")}>Approve</Button>
                <Button variant="danger" onClick={() => act(b.block_id, "flag")}>Flag</Button>
              </>
            )}
          </span>,
        ])}
      />
      {openId && (() => {
        const b = blocks.find((x) => x.block_id === openId);
        const sb = b ? seigniorageBreakdown(b.seigniorage_fee_inr) : null;
        return (
          <div style={{ marginTop: 16, background: "var(--sos-light)", borderRadius: 8, padding: 16 }}>
            {b && sb && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  Seigniorage assessment (Form-M) — {b.category_name ?? classificationLabel(b.classification)}
                </div>
                <div style={{ maxWidth: 460, display: "grid", gap: 4 }}>
                  <BreakRow label={`Base seigniorage${b.rate_per_m3_inr != null ? ` (@ ${inr(b.rate_per_m3_inr)}/m³)` : ""}`} value={inrExact(sb.base)} />
                  <BreakRow label="District Mineral Foundation (DMF 10%)" value={inrExact(sb.dmf)} />
                  <BreakRow label="National Mineral Explr. Trust (NMET 2%)" value={inrExact(sb.nmet)} />
                  <div style={{ borderTop: "1px solid var(--sos-border)", paddingTop: 4 }}>
                    <BreakRow label="Total challan payable" value={inrExact(sb.total)} bold />
                  </div>
                  {b.tonnage_mt != null && <BreakRow label="Tonnage (MT basis)" value={`${b.tonnage_mt} MT`} />}
                </div>
              </div>
            )}
            <div style={{ fontWeight: 700, marginBottom: 12 }}>Lifecycle & audit trail — {openId}</div>
            <AuditTimeline events={audit} />
            <p style={{ color: "var(--sos-text-muted)", fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              Every measurement, classification, OMEPS cross-validation and officer decision is recorded as an
              immutable audit event — full traceability from quarry to dispatch (requirement 5).
            </p>
          </div>
        );
      })()}
    </Card>
  );
}

function BreakRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
      <span style={{ color: "var(--sos-text-muted)" }}>{label}</span>
      <span style={{ fontWeight: bold ? 700 : 500, fontFamily: "ui-monospace, monospace" }}>{value}</span>
    </div>
  );
}
