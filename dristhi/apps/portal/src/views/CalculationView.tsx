import React, { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, Badge, Button, inr, inrExact, classificationLabel } from "@drishti/ui";
import { api, Calculation, CalcStep } from "../api";
import { Banner, Kpi, errText, fmtTime, linkButton, mono, short, td, th, usePolling } from "./shared";

const statusTone = (s: Calculation["status"]) => (s === "completed" ? "success" : s === "failed" ? "danger" : "warning");

/** Portal-side calculations: how each block's volume, class and fee were derived. */
export function CalculationView({ canRetry }: { canRetry: boolean }) {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("calc");
  const [calcs, setCalcs] = useState<Calculation[]>([]);
  const [extra, setExtra] = useState<Calculation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setCalcs(await api.calculations(200));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  usePolling(load, 4000);

  const inList = calcs.find((c) => c.calc_id === selectedId) ?? null;
  // A deep link (e.g. from the Robot View) may point past the list window, or
  // arrive before the calculation finished: fetch it directly.
  useEffect(() => {
    setExtra(null);
    if (!selectedId || inList) return;
    api.calculation(selectedId).then(setExtra).catch(() => setExtra(null));
  }, [selectedId, inList]);
  const selected = inList ?? extra;

  const select = (id: string | null) => setParams(id ? { calc: id } : {});

  const retry = async (id: string) => {
    setRetrying(true);
    try {
      await api.retryCalculation(id);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setRetrying(false);
    }
  };

  const completed = calcs.filter((c) => c.status === "completed");
  const revenue = completed.reduce((a, c) => a + (c.outputs.total_payable_inr ?? 0), 0);
  const withWarnings = calcs.filter((c) => c.warnings?.length).length;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0 }}>Calculations</h2>
        <p style={{ margin: "4px 0 0", color: "var(--sos-text-muted)", fontSize: 13 }}>
          Everything derived from a robot's raw capture is computed here: dimensions and volume (vision service), gangsaw
          class, seigniorage, Form-M levies and tonnage (seigniorage engine), and the concession geofence check.
        </p>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <Kpi label="CALCULATIONS" value={calcs.length} />
        <Kpi label="COMPLETED" value={completed.length} color="var(--sos-success)" />
        <Kpi label="WITH WARNINGS" value={withWarnings} color={withWarnings ? "#B26A00" : undefined} />
        <Kpi label="FAILED" value={calcs.filter((c) => c.status === "failed").length} color="var(--sos-danger)" />
        <Kpi label="TOTAL PAYABLE" value={inr(revenue)} />
      </div>

      {selected && (
        <CalcDetail calc={selected} onClose={() => select(null)} canRetry={canRetry} retrying={retrying} onRetry={retry} />
      )}
      {selectedId && !selected && loaded && (
        <Banner tone="warning">Calculation {short(selectedId, 13)} not found yet. It appears here once the capture reaches the Portal.</Banner>
      )}

      <Card style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Calculation ledger</h3>
        {calcs.length === 0 ? (
          <p style={{ margin: 0, color: "var(--sos-text-muted)", fontSize: 13 }}>{loaded ? "No calculations yet." : "Loading…"}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Created", "Block", "Source", "Quarry", "Volume", "Class", "Fee", "Total payable", "Warnings", "Status"].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {calcs.map((c) => (
                  <tr key={c.calc_id} style={c.calc_id === selectedId ? { background: "var(--sos-light)" } : undefined}>
                    <td style={td}>
                      <button style={{ ...linkButton, whiteSpace: "nowrap" }} onClick={() => select(c.calc_id === selectedId ? null : c.calc_id)} aria-pressed={c.calc_id === selectedId}>
                        {fmtTime(c.created_at)}
                      </button>
                    </td>
                    <td style={{ ...td, ...mono, whiteSpace: "nowrap" }}>{c.block_id ?? "—"}</td>
                    <td style={td}>{c.source}{c.device_id ? <span style={{ color: "var(--sos-text-muted)" }}> · {c.device_id}</span> : null}</td>
                    <td style={td}>{c.quarry_id ?? "—"}</td>
                    <td style={{ ...td, ...mono }}>{c.outputs.volume_m3 != null ? `${c.outputs.volume_m3} m³` : "—"}</td>
                    <td style={td}>{c.outputs.classification ? classificationLabel(c.outputs.classification) : "—"}</td>
                    <td style={{ ...td, ...mono }}>{c.outputs.seigniorage_fee_inr != null ? inr(c.outputs.seigniorage_fee_inr) : "—"}</td>
                    <td style={{ ...td, ...mono }}>{c.outputs.total_payable_inr != null ? inr(c.outputs.total_payable_inr) : "—"}</td>
                    <td style={td}>{c.warnings?.length ? <Badge tone="warning">{c.warnings.length}</Badge> : "—"}</td>
                    <td style={td}><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
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

function CalcDetail({ calc, onClose, canRetry, retrying, onRetry }: {
  calc: Calculation; onClose: () => void; canRetry: boolean; retrying: boolean; onRetry: (id: string) => void;
}) {
  return (
    <Card style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--sos-text-muted)", letterSpacing: 0.5 }}>CALCULATION {short(calc.calc_id, 13)}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {calc.block_id ?? "Block pending"} <Badge tone={statusTone(calc.status)}>{calc.status}</Badge>
          </div>
          <div style={{ fontSize: 12, color: "var(--sos-text-muted)" }}>
            {calc.source}{calc.device_id ? ` · ${calc.device_id}` : ""} · {calc.quarry_id ?? "—"} · updated {fmtTime(calc.updated_at)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {calc.status === "completed" && calc.block_id && <Link to="/approvals">Review in Approvals →</Link>}
          {canRetry && calc.capture_id && calc.status !== "completed" && (
            <Button onClick={() => onRetry(calc.calc_id)} disabled={retrying}>{retrying ? "Re-running…" : "Re-run calculation"}</Button>
          )}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>

      {calc.error && <Banner tone="danger">Calculation failed: {calc.error}</Banner>}
      {calc.warnings?.map((w) => <Banner key={w.code} tone="warning"><b>{w.code}</b> · {w.message}</Banner>)}

      {calc.outputs.total_payable_inr != null && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <Kpi label="VOLUME" value={`${calc.outputs.volume_m3} m³`} />
          <Kpi label="CLASS" value={classificationLabel(calc.outputs.classification)} />
          <Kpi label="SEIGNIORAGE" value={inrExact(calc.outputs.seigniorage_fee_inr)} />
          <Kpi label="TOTAL CHALLAN" value={inrExact(calc.outputs.total_payable_inr)} color="#B26A00" />
          <Kpi label="TONNAGE" value={`${calc.outputs.tonnage_mt} MT`} />
        </div>
      )}

      <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 8 }}>
        {calc.steps.map((s, i) => <StepCard key={`${s.step}-${i}`} index={i + 1} step={s} />)}
      </ol>
    </Card>
  );
}

function StepCard({ index, step }: { index: number; step: CalcStep }) {
  const entries = Object.entries(step.values ?? {});
  return (
    <li style={{ border: "1px solid var(--sos-border)", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{index}. {step.title}</span>
        {step.engine && <span style={{ ...mono, color: "var(--sos-text-muted)" }}>{step.engine}</span>}
      </div>
      {step.formula && <div style={{ ...mono, marginTop: 4, color: "var(--sos-section-blue)" }}>{step.formula}</div>}
      {entries.length > 0 && (
        <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "4px 16px" }}>
          {entries.map(([k, v]) => {
            const text = fmtValue(k, v);
            // Break inside a value only for long unbroken tokens (hashes);
            // short words like "black_galaxy" stay whole and the label wraps.
            const longToken = /\S{25,}/.test(text);
            return (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <dt style={{ color: "var(--sos-text-muted)" }}>{k.replace(/_/g, " ")}</dt>
                <dd style={{ margin: 0, ...mono, textAlign: "right", overflowWrap: longToken ? "anywhere" : "break-word", minWidth: longToken ? 0 : undefined }}>{text}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </li>
  );
}

function fmtValue(key: string, v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    if (key.endsWith("_inr")) return inrExact(v);
    if (key.endsWith("_rate")) return `${(v * 100).toFixed(2)}%`;
    return String(v);
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") {
    // e.g. a GNSS fix -> "lat 15.58 · lon 79.86 · accuracy m 0.03 · fix RTK_FIXED"
    return Object.entries(v as Record<string, unknown>)
      .map(([k2, x]) => `${k2.replace(/_/g, " ")} ${x ?? "—"}`)
      .join(" · ");
  }
  return String(v);
}
