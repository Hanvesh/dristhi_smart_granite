import React, { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Card, Badge, Button, inr, inrExact, classificationLabel } from "@drishti/ui";
import { api, ApprovalQueueItem, ApprovalRecord } from "../api";
import { Banner, Kpi, errText, fmtTime, mono, td, th, usePolling } from "./shared";

interface Draft { note: string; weight: string; busy: boolean; error: string | null; }
const emptyDraft: Draft = { note: "", weight: "", busy: false, error: null };
type SourceFilter = "all" | "robot" | "mobile";

/** Officer approvals: decide on blocks using the Portal's calculation. */
export function ApprovalView() {
  const [queue, setQueue] = useState<ApprovalQueueItem[]>([]);
  const [history, setHistory] = useState<ApprovalRecord[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<SourceFilter>("robot");

  const load = useCallback(async () => {
    try {
      const [q, h] = await Promise.all([api.approvalQueue(), api.approvals(50)]);
      setQueue(q);
      setHistory(h);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  usePolling(load, 5000);

  const draft = (id: string) => drafts[id] ?? emptyDraft;
  const patch = (id: string, p: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? emptyDraft), ...p } }));

  const decide = async (id: string, decision: "approve" | "reject") => {
    patch(id, { busy: true, error: null });
    try {
      const rec = await api.decide(id, decision, draft(id).note.trim() || undefined);
      setNotice(rec.decision === "approved"
        ? `${id} approved · e-transit pass ${rec.e_transit_pass_no} issued`
        : `${id} rejected`);
      setDrafts((d) => { const { [id]: _, ...rest } = d; return rest; });
      await load();
    } catch (e) {
      patch(id, { busy: false, error: errText(e) });
    }
  };

  const omeps = async (id: string) => {
    const w = Number(draft(id).weight);
    if (!draft(id).weight || !Number.isFinite(w) || w <= 0) {
      patch(id, { error: "Enter the weighbridge weight in MT to cross-check." });
      return;
    }
    patch(id, { busy: true, error: null });
    try {
      const r = await api.omepsSync(id, w);
      setNotice(`${id}: ${r.message}${r.divergence != null ? ` (divergence ${(r.divergence * 100).toFixed(1)}%)` : ""}`);
      patch(id, { busy: false });
      await load();
    } catch (e) {
      patch(id, { busy: false, error: errText(e) });
    }
  };

  const shown = queue.filter((i) => source === "all" || i.block.source === source);
  const today = new Date().toDateString();
  const decidedToday = history.filter((h) => new Date(h.created_at).toDateString() === today);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0 }}>Approvals</h2>
          <p style={{ margin: "4px 0 0", color: "var(--sos-text-muted)", fontSize: 13 }}>
            Approve or reject blocks using the Portal's calculation. Approval issues the e-transit pass. Blocks with
            calculation warnings or an OMEPS flag need a justification note; rejections always need a reason.
          </p>
        </div>
        <label style={{ fontSize: 13, color: "var(--sos-text-muted)" }}>
          Source{" "}
          <select value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--sos-border)" }}>
            <option value="robot">robot captures</option>
            <option value="mobile">field captures</option>
            <option value="all">all</option>
          </select>
        </label>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <Kpi label="AWAITING DECISION" value={queue.length} />
        <Kpi label="WITH WARNINGS" value={queue.filter((i) => i.calculation?.warnings?.length).length} color="#B26A00" />
        <Kpi label="OMEPS FLAGGED" value={queue.filter((i) => i.block.status === "flagged").length} color="var(--sos-danger)" />
        <Kpi label="DECIDED TODAY" value={decidedToday.length} color="var(--sos-success)" />
      </div>

      {shown.length === 0 && (
        <Card>
          <p style={{ margin: 0, color: "var(--sos-text-muted)" }}>
            {!loaded ? "Loading…"
              : source !== "all" && queue.length
                ? `No ${source === "robot" ? "robot" : "field"} captures awaiting a decision. ${queue.length} other block(s) are waiting; set Source to “all” to see them.`
                : "Nothing waiting for a decision."}
          </p>
        </Card>
      )}

      {shown.map((item) => {
        const b = item.block;
        const c = item.calculation;
        const out = c?.outputs;
        const d = draft(b.block_id);
        const warn = c?.warnings ?? [];
        const needsNote = warn.length > 0 || b.status === "flagged";
        return (
          <Card key={b.block_id} style={{ padding: 16, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, ...mono }}>{b.block_id}</div>
                <div style={{ fontSize: 12, color: "var(--sos-text-muted)" }}>
                  {b.quarry_id} · {b.source}{c?.device_id ? ` · ${c.device_id}` : ""} · {c ? `calculated ${fmtTime(c.created_at)}` : "no calculation record (seed data)"}
                </div>
              </div>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge tone={b.status === "flagged" ? "danger" : "warning"}>{b.status}</Badge>
                {c && <Link to={`/calculations?calc=${encodeURIComponent(c.calc_id)}`}>View calculation →</Link>}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
              <Fact label="Volume" value={`${out?.volume_m3 ?? b.volume_m3} m³`} />
              <Fact label="Class" value={classificationLabel(out?.classification ?? b.classification)} />
              <Fact label="Category" value={out?.category_name ?? b.category_name ?? "—"} />
              <Fact label="Seigniorage" value={inrExact(out?.seigniorage_fee_inr ?? b.seigniorage_fee_inr)} />
              <Fact label="Total challan" value={out?.total_payable_inr != null ? inrExact(out.total_payable_inr) : "—"} strong />
              <Fact label="Confidence" value={`${Math.round((out?.confidence ?? b.confidence) * 100)}%`} />
            </div>

            {warn.map((w) => <Banner key={w.code} tone="warning"><b>{w.code}</b> · {w.message}</Banner>)}
            {item.omeps && (
              <Banner tone={item.omeps.anomaly ? "danger" : "info"}>
                OMEPS 2.0: {item.omeps.message}
                {item.omeps.weighbridge_volume_m3 != null && ` · weighbridge ${item.omeps.weighbridge_volume_m3} m³`}
                {item.omeps.divergence != null && ` · divergence ${(item.omeps.divergence * 100).toFixed(1)}%`}
              </Banner>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) 1fr", gap: 12, alignItems: "start" }}>
              <div style={{ display: "grid", gap: 6 }}>
                <label htmlFor={`wb-${b.block_id}`} style={{ fontSize: 12, fontWeight: 600, color: "var(--sos-text-muted)" }}>Weighbridge weight (MT)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input id={`wb-${b.block_id}`} type="number" min="0" step="0.01" value={d.weight}
                    onChange={(e) => patch(b.block_id, { weight: e.target.value })} style={inputStyle} />
                  <Button variant="ghost" onClick={() => omeps(b.block_id)} disabled={d.busy} style={{ whiteSpace: "nowrap" }}>OMEPS check</Button>
                </div>
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <label htmlFor={`note-${b.block_id}`} style={{ fontSize: 12, fontWeight: 600, color: "var(--sos-text-muted)" }}>
                  Officer note {needsNote ? "(required to approve)" : "(required to reject)"}
                </label>
                <textarea id={`note-${b.block_id}`} rows={2} maxLength={500} value={d.note}
                  onChange={(e) => patch(b.block_id, { note: e.target.value })} style={{ ...inputStyle, resize: "vertical" }} />
              </div>
            </div>

            {d.error && <Banner tone="danger">{d.error}</Banner>}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="danger" onClick={() => decide(b.block_id, "reject")} disabled={d.busy || !d.note.trim()}>Reject</Button>
              <Button variant="success" onClick={() => decide(b.block_id, "approve")} disabled={d.busy || (needsNote && !d.note.trim())}>
                Approve &amp; issue e-transit pass
              </Button>
            </div>
          </Card>
        );
      })}

      <Card style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Decision history</h3>
        {history.length === 0 ? (
          <p style={{ margin: 0, color: "var(--sos-text-muted)", fontSize: 13 }}>No decisions yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Decided", "Block", "Decision", "Officer", "Note", "E-transit pass", "Total challan"].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td style={td}>{fmtTime(h.created_at)}</td>
                    <td style={{ ...td, ...mono }}>{h.block_id}</td>
                    <td style={td}><Badge tone={h.decision === "approved" ? "success" : "danger"}>{h.decision}</Badge></td>
                    <td style={td}>{h.actor}</td>
                    <td style={td}>{h.note ?? "—"}</td>
                    <td style={{ ...td, ...mono }}>{h.e_transit_pass_no ?? "—"}</td>
                    <td style={{ ...td, ...mono }}>{h.total_payable_inr != null ? inr(h.total_payable_inr) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ border: "1px solid var(--sos-border)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 11, color: "var(--sos-text-muted)" }}>{label}</div>
      <div style={{ ...mono, fontSize: 14, fontWeight: strong ? 700 : 500 }}>{value}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius-sm)",
  fontSize: 14, fontFamily: "inherit", boxSizing: "border-box",
};
