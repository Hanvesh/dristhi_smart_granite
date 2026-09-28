import React, { useEffect, useState } from "react";
import { Card } from "@drishti/ui";
import { api } from "../api";
import { DEMO_BLOCKS } from "../demoData";

interface Summary { total: number; approved: number; pending: number; revenue_inr: number; anomalies: number; }

export function AnalyticsView() {
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    api.analytics().then(setS).catch(() => {
      const total = DEMO_BLOCKS.length;
      setS({
        total,
        approved: DEMO_BLOCKS.filter((b) => b.status === "approved").length,
        pending: DEMO_BLOCKS.filter((b) => b.status === "pending").length,
        revenue_inr: DEMO_BLOCKS.reduce((a, b) => a + b.seigniorage_fee_inr, 0),
        anomalies: DEMO_BLOCKS.filter((b) => b.status === "flagged").length,
      });
    });
  }, []);

  if (!s) return <p>Loading…</p>;

  const stat = (label: string, value: React.ReactNode) => (
    <Card style={{ flex: 1 }}>
      <div style={{ color: "var(--sos-text-muted)", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "var(--sos-dark)" }}>{value}</div>
    </Card>
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h2 style={{ margin: 0 }}>Department Analytics</h2>
      <div style={{ display: "flex", gap: 16 }}>
        {stat("Total blocks", s.total)}
        {stat("Approved", s.approved)}
        {stat("Pending", s.pending)}
        {stat("Anomalies", s.anomalies)}
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        {stat("Seigniorage revenue", `₹${s.revenue_inr.toLocaleString("en-IN")}`)}
      </div>
    </div>
  );
}
