import React from "react";

/** Circular battery gauge. `percent` 0-100. Turns amber/red as it drains.
 *  Ported from drishti_robot_demo/frontend-next/components/BatteryGauge.js. */
export function BatteryGauge({ percent = 100, size = 120 }: { percent?: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, percent));
  const r = 44;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;

  let color = "#10b981";
  if (pct <= 20) color = "#ef4444";
  else if (pct <= 45) color = "#f97316";

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg viewBox="0 0 100 100" style={{ height: "100%", width: "100%", transform: "rotate(-90deg)" }}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e7e5e4" strokeWidth="9" />
        <circle
          cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ transition: "stroke-dasharray .6s ease, stroke .3s ease" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 22, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
        <span style={{ fontSize: 9, fontFamily: "ui-monospace, monospace", letterSpacing: 2, color: "#9ca3af" }}>CELL PACK</span>
      </div>
    </div>
  );
}
