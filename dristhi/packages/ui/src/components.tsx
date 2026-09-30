import React from "react";

type Div = React.HTMLAttributes<HTMLDivElement>;

export function Card({ children, style, ...rest }: Div) {
  return (
    <div
      {...rest}
      style={{
        background: "var(--sos-surface)",
        border: "1px solid var(--sos-border)",
        borderRadius: "var(--sos-radius)",
        boxShadow: "var(--sos-shadow)",
        padding: "var(--sos-space-5)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  style,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "success";
}) {
  const bg = {
    primary: "var(--sos-blue)",
    ghost: "transparent",
    danger: "var(--sos-danger)",
    success: "var(--sos-success)",
  }[variant];
  const color = variant === "ghost" ? "var(--sos-blue)" : "#fff";
  return (
    <button
      {...rest}
      style={{
        background: bg,
        color,
        border: variant === "ghost" ? "1px solid var(--sos-blue)" : "none",
        borderRadius: "var(--sos-radius-sm)",
        padding: "8px 16px",
        fontWeight: 600,
        // Disabled buttons must look disabled, or a click that does nothing reads as a bug.
        cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.55 : 1,
        fontSize: 14,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Badge({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "danger"; children: React.ReactNode }) {
  const map = {
    info: ["var(--sos-light)", "var(--sos-section-blue)"],
    success: ["#E6F4EA", "var(--sos-success)"],
    warning: ["#FFF4E0", "#B26A00"],
    danger: ["#FDE8E8", "var(--sos-danger)"],
  }[tone];
  return (
    <span
      style={{
        background: map[0],
        color: map[1],
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

export function TopNav({ title, right }: { title: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px",
        background: "var(--sos-surface)",
        borderBottom: "1px solid var(--sos-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>{title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>{right}</div>
    </header>
  );
}

export function Table({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c}
              style={{
                textAlign: "left",
                padding: "10px 12px",
                color: "var(--sos-text-muted)",
                borderBottom: "2px solid var(--sos-border)",
                fontWeight: 600,
              }}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => (
              <td key={j} style={{ padding: "10px 12px", borderBottom: "1px solid var(--sos-border)" }}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
