import React, { useEffect } from "react";
import { ApiError } from "../api";

/** Run `fn` now and every `ms` while mounted. */
export function usePolling(fn: () => void | Promise<void>, ms: number) {
  useEffect(() => {
    fn();
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}

export const fmtTime = (ts?: string | null) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" });
};

export const short = (s?: string | null, n = 10) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "—");

/** Badge tone for a block status. */
export const statusTone = (status?: string | null) =>
  status === "approved" ? "success" : status === "flagged" || status === "rejected" ? "danger" : "warning";

/** Case-insensitive search: every space-separated term must appear somewhere in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = text.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** Search input used by the list pages. Escape clears it. */
export function SearchBox({ value, onChange, label, placeholder }: {
  value: string; onChange: (v: string) => void; label: string; placeholder: string;
}) {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); onChange(""); } }}
      style={{
        padding: "8px 10px", border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius-sm)",
        fontSize: 13, fontFamily: "inherit", width: 300, maxWidth: "100%", boxSizing: "border-box",
      }}
    />
  );
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail || `Gateway returned HTTP ${e.status}.`;
  return "Gateway not reachable. Start the backend (./scripts/bootstrap.sh) and try again.";
}

export function Kpi({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: "var(--sos-surface)", border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 11, letterSpacing: 0.5, color: "var(--sos-text-muted)", fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 22, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: color ?? "var(--sos-text)" }}>{value}</div>
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, lineHeight: 1.5, background: "var(--sos-surface)", border: "1px solid var(--sos-border)", borderRadius: 8, padding: 12, maxHeight: 320, overflow: "auto" }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Banner({ tone, children }: { tone: "danger" | "warning" | "info"; children: React.ReactNode }) {
  const c = { danger: "var(--sos-danger)", warning: "#B26A00", info: "var(--sos-section-blue)" }[tone];
  const bg = { danger: "rgba(198,40,40,0.07)", warning: "#FFF4E0", info: "var(--sos-light)" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} style={{ border: `1px solid ${c}`, background: bg, color: c, borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
      {children}
    </div>
  );
}

export const th: React.CSSProperties = {
  textAlign: "left", padding: "10px 8px", color: "var(--sos-text-muted)", borderBottom: "2px solid var(--sos-border)",
  fontWeight: 600, fontSize: 12, whiteSpace: "nowrap",
};
export const td: React.CSSProperties = { padding: "9px 8px", borderBottom: "1px solid var(--sos-border)", fontSize: 13, verticalAlign: "top" };
export const mono: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: 12 };
export const linkButton: React.CSSProperties = {
  background: "none", border: "none", padding: 0, color: "var(--sos-blue)", cursor: "pointer", fontWeight: 600, fontSize: 13,
  fontFamily: "ui-monospace, monospace",
};
