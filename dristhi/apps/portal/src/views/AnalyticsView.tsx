import React, { useEffect, useMemo, useState } from "react";
import { Card, Badge, inr, graniteLabel, QUARRIES, captureBus, CapturedBlock } from "@drishti/ui";
import { api, Block } from "../api";
import { DEMO_BLOCKS } from "../demoData";

const GANGSAW_THRESHOLD_M3 = 2.5;
const CATEGORY_COLOR: Record<string, string> = { black_galaxy: "#702cf6", colour: "#f97316", grey: "#78716c" };

// A block, normalised across the gateway Block shape and the shared capture bus.
interface Row {
  blockId: string;
  quarryCode: string;
  graniteType: string;
  volumeM3: number;
  feeInr: number;
  classification: string;
  assessed: boolean;
}

// Map the gateway granite_category (black_galaxy | srikakulam_blue | generic)
// onto the analytics scheme (black_galaxy | colour | grey).
const normType = (t?: string): string =>
  t === "black_galaxy" ? "black_galaxy" : t === "colour" || t === "srikakulam_blue" ? "colour" : "grey";

// Best-effort quarry code from a gateway block_id like QRY-AMR-2026-0100 /
// QRY-ONG-... — matched against the shared registry by prefix.
const codeFromBlock = (b: { quarry_id?: string; block_id: string }): string => {
  if (b.quarry_id && b.quarry_id.startsWith("APQRY")) return b.quarry_id;
  return QUARRIES[0].code;
};

export function AnalyticsView() {
  const [gatewayBlocks, setGatewayBlocks] = useState<Block[] | null>(null);
  const [captures, setCaptures] = useState<CapturedBlock[]>(captureBus.list());

  useEffect(() => {
    api.listBlocks().then(setGatewayBlocks).catch(() => setGatewayBlocks(DEMO_BLOCKS));
    const unsub = captureBus.subscribe(setCaptures);
    return unsub;
  }, []);

  const rows: Row[] = useMemo(() => {
    const base: Row[] = (gatewayBlocks ?? []).map((b) => ({
      blockId: b.block_id, quarryCode: codeFromBlock(b), graniteType: normType(b.granite_category),
      volumeM3: b.volume_m3 || 0, feeInr: b.seigniorage_fee_inr || 0,
      classification: b.classification, assessed: b.status !== "pending",
    }));
    const cap: Row[] = captures.map((c) => ({
      blockId: c.blockId, quarryCode: c.quarryCode, graniteType: c.graniteType,
      volumeM3: c.volumeM3, feeInr: c.seigniorageFeeInr, classification: c.classification, assessed: true,
    }));
    // De-dup by blockId (captures win).
    const byId = new Map<string, Row>();
    [...base, ...cap].forEach((r) => byId.set(r.blockId, r));
    return [...byId.values()];
  }, [gatewayBlocks, captures]);

  // Aggregates.
  const totalBlocks = rows.length;
  const scanned = rows.filter((r) => r.assessed).length;
  const totalVolume = rows.reduce((a, r) => a + r.volumeM3, 0);
  const totalFee = rows.reduce((a, r) => a + r.feeInr, 0);
  const above = rows.filter((r) => r.classification === "above_gangsaw").length;
  const below = rows.filter((r) => r.classification === "below_gangsaw").length;
  const abovePct = above + below ? Math.round((above / (above + below)) * 1000) / 10 : 0;
  const avgFee = scanned ? totalFee / scanned : 0;

  const byCategory: Record<string, number> = { black_galaxy: 0, colour: 0, grey: 0 };
  rows.forEach((r) => { byCategory[r.graniteType] = (byCategory[r.graniteType] || 0) + r.feeInr; });
  const maxCatFee = Math.max(1, ...Object.values(byCategory));

  // Per-quarry register.
  const perQuarry = QUARRIES.map((q) => {
    const qr = rows.filter((r) => r.quarryCode === q.code);
    const qScanned = qr.filter((r) => r.assessed).length;
    return {
      code: q.code, name: q.name, district: q.district, graniteType: q.type,
      totalBlocks: qr.length, scanned: qScanned,
      progressPct: qr.length ? Math.round((qScanned / qr.length) * 100) : 0,
      volume: qr.reduce((a, r) => a + r.volumeM3, 0),
      fee: qr.reduce((a, r) => a + r.feeInr, 0),
      status: qr.length === 0 ? "PENDING" : qScanned === qr.length ? "COMPLETED" : "IN_PROGRESS",
    };
  }).filter((q) => q.totalBlocks > 0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Andhra Pradesh State Granite Fleet &amp; Seigniorage Telemetry</h2>
        <Badge tone="info">CAMPAIGN CY-2026-Q1</Badge>
        <Badge tone="success">RTK BASE SYNCHRONIZED</Badge>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <Kpi label="TOTAL SEIGNIORAGE ASSESSED" value={inr(totalFee)} sub="Base royalty + DMF + NMET" accent="#ea580c" />
        <Kpi label="BLOCKS SCANNED" value={`${scanned} / ${totalBlocks}`} sub={`${totalBlocks ? Math.round((scanned / totalBlocks) * 100) : 0}% surveyed`} />
        <Kpi label="TOTAL NET VOLUME" value={`${totalVolume.toFixed(2)} m³`} sub="LiDAR net" accent="#702cf6" />
        <Kpi label="AVG FEE / BLOCK" value={inr(avgFee)} sub="assessed blocks" />
      </div>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {/* Gangsaw donut */}
        <Card>
          <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Gangsaw Classification</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Donut abovePct={abovePct} />
            <div style={{ display: "grid", gap: 8 }}>
              <LegendRow color="#702cf6" label={`Above Gangsaw (≥ ${GANGSAW_THRESHOLD_M3} m³)`} count={above} />
              <LegendRow color="#f97316" label={`Below Gangsaw (< ${GANGSAW_THRESHOLD_M3} m³)`} count={below} />
            </div>
          </div>
        </Card>

        {/* Seigniorage by category */}
        <Card>
          <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Seigniorage by Granite Category</h3>
          <div style={{ display: "grid", gap: 10 }}>
            {Object.entries(byCategory).map(([cat, fee]) => (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span>{graniteLabel(cat)}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>{inr(fee)}</span>
                </div>
                <div style={{ height: 10, borderRadius: 6, background: "var(--sos-light)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(fee / maxCatFee) * 100}%`, background: CATEGORY_COLOR[cat], borderRadius: 6, transition: "width .4s ease" }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Per-quarry progress */}
        <Card>
          <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Per-Quarry Survey Progress</h3>
          <div style={{ display: "grid", gap: 10, maxHeight: 220, overflowY: "auto" }}>
            {perQuarry.length === 0 && <p style={{ color: "var(--sos-text-muted)", fontSize: 13, margin: 0 }}>No blocks yet.</p>}
            {perQuarry.map((q) => (
              <div key={q.code}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span>{q.code}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>{q.scanned}/{q.totalBlocks}</span>
                </div>
                <div style={{ height: 8, borderRadius: 6, background: "var(--sos-light)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${q.progressPct}%`, background: "linear-gradient(90deg, #702cf6, #10b981)", borderRadius: 6 }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Master register table */}
      <Card>
        <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Per-Quarry Master Register &amp; Seigniorage Table</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontFamily: "ui-monospace, monospace", fontSize: 10, letterSpacing: 0.5, color: "var(--sos-text-muted)" }}>
                <th style={{ padding: "8px 6px" }}>CODE</th><th>CONCESSION</th><th>DISTRICT</th><th>GRANITE</th>
                <th>SCANNED</th><th style={{ textAlign: "right" }}>NET VOL</th><th style={{ textAlign: "right" }}>SEIGNIORAGE</th><th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {perQuarry.map((q) => (
                <tr key={q.code} style={{ borderTop: "1px solid var(--sos-border)" }}>
                  <td style={{ padding: "8px 6px", fontFamily: "ui-monospace, monospace", color: "var(--sos-blue)" }}>{q.code}</td>
                  <td>{q.name}</td>
                  <td style={{ color: "var(--sos-text-muted)" }}>{q.district}</td>
                  <td>{graniteLabel(q.graniteType)}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace" }}>{q.scanned}/{q.totalBlocks}</td>
                  <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{q.volume.toFixed(2)} m³</td>
                  <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{inr(q.fee)}</td>
                  <td><StatusBadge status={q.status} /></td>
                </tr>
              ))}
              {perQuarry.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 12, textAlign: "center", color: "var(--sos-text-muted)" }}>No quarry data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 8, fontSize: 11, color: "var(--sos-text-muted)" }}>
          {perQuarry.length} quarries with blocks · Avg fee/block {inr(avgFee)} · Gangsaw threshold {GANGSAW_THRESHOLD_M3} m³
        </p>
      </Card>
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: string }) {
  return (
    <Card>
      <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", letterSpacing: 1.2, color: "var(--sos-text-muted)" }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 26, fontWeight: 700, color: accent ?? "var(--sos-dark)" }}>{value}</div>
      {sub && <div style={{ marginTop: 4, fontSize: 11, color: "var(--sos-text-muted)" }}>{sub}</div>}
    </Card>
  );
}

function Donut({ abovePct }: { abovePct: number }) {
  const r = 52, c = 2 * Math.PI * r;
  const dash = (abovePct / 100) * c;
  return (
    <div style={{ position: "relative", width: 130, height: 130 }}>
      <svg viewBox="0 0 130 130" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}>
        <circle cx="65" cy="65" r={r} fill="none" stroke="#f97316" strokeWidth="16" />
        <circle cx="65" cy="65" r={r} fill="none" stroke="#702cf6" strokeWidth="16" strokeDasharray={`${dash} ${c}`} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 22, fontWeight: 700, color: "#702cf6" }}>{abovePct}%</span>
        <span style={{ fontSize: 9, color: "var(--sos-text-muted)" }}>above</span>
      </div>
    </div>
  );
}

function LegendRow({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{count}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "COMPLETED" ? "success" : status === "IN_PROGRESS" ? "info" : "warning";
  const label = status === "COMPLETED" ? "DONE" : status === "IN_PROGRESS" ? "ACTIVE" : "PENDING";
  return <Badge tone={tone as "success" | "info" | "warning"}>{label}</Badge>;
}
