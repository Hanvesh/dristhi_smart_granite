import React, { useEffect, useState } from "react";
import { Card, Table, Button, Badge } from "@drishti/ui";
import { api, Block, AuditEvent } from "../api";
import { DEMO_BLOCKS } from "../demoData";
import { AuditTimeline } from "./AuditView";
import type { Role } from "../auth";

const toneFor = (status: string) =>
  status === "approved" ? "success" : status === "flagged" ? "danger" : "warning";

export function BlocksView({ role }: { role: Role }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [live, setLive] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

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
    try {
      if (action === "approve") await api.approve(id);
      else await api.flag(id);
      await load();
      if (openId === id) setAudit(await api.blockAudit(id));
    } catch {
      setBlocks((b) => b.map((x) => (x.block_id === id ? { ...x, status: action === "approve" ? "approved" : "flagged" } : x)));
    }
  };

  const runOmeps = async (id: string) => {
    setBusy(id);
    try {
      // A deliberately low weighbridge weight to demo anomaly detection.
      await api.omepsSync(id, 6.4);
      await load();
      if (openId === id) setAudit(await api.blockAudit(id));
    } catch {
      /* offline: ignore */
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
      <Table
        columns={["Block ID", "Quarry", "L×W×H (m)", "Volume", "Class", "Conf.", "Fee (INR)", "Status", "Actions"]}
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
          b.classification.replace("_", " "),
          `${Math.round(b.confidence * 100)}%`,
          b.seigniorage_fee_inr.toLocaleString("en-IN"),
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
      {openId && (
        <div style={{ marginTop: 16, background: "var(--sos-light)", borderRadius: 8, padding: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Lifecycle & audit trail — {openId}</div>
          <AuditTimeline events={audit} />
          <p style={{ color: "var(--sos-text-muted)", fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            Every measurement, classification, OMEPS cross-validation and officer decision is recorded as an
            immutable audit event — full traceability from quarry to dispatch (requirement 5).
          </p>
        </div>
      )}
    </Card>
  );
}
