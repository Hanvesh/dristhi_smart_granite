import React, { useState } from "react";
import { Routes, Route, NavLink, useNavigate, useLocation, Navigate } from "react-router-dom";
import { BrandLogo, TopNav, Button, Badge } from "@drishti/ui";
import { getSession, logout, Session } from "./auth";
import { Login } from "./Login";
import { BlocksView } from "./views/BlocksView";
import { AnalyticsView } from "./views/AnalyticsView";
import { CaptureView } from "./views/CaptureView";
import { AuditView } from "./views/AuditView";
import { TransmissionView } from "./views/TransmissionView";
import { CalculationView } from "./views/CalculationView";
import { ApprovalView } from "./views/ApprovalView";
import { robotViewUrl } from "./robotLink";

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const navigate = useNavigate();
  const location = useLocation();

  if (!session) {
    return <Login onLogin={() => setSession(getSession())} />;
  }

  const signOut = () => {
    logout();
    setSession(null);
    navigate("/");
  };

  const canReview = session.role === "officer" || session.role === "admin";
  const canAnalytics = session.role === "admin";
  const canCapture = session.role === "operator" || session.role === "admin";
  const canAudit = session.role === "officer" || session.role === "admin";
  // Robot -> portal pipeline: every signed-in role can follow the data
  // (Data Transmission, Calculations); only officers/admins decide.
  const canApprove = canReview;
  const canRobotView = session.role === "operator" || session.role === "admin";

  // Sections live in their own tab bar under the top bar, so adding pages
  // never squeezes the brand or account controls into wrapped text.
  const sections = [
    { to: "/blocks", label: "Blocks", show: canReview },
    { to: "/capture", label: "New Capture", show: canCapture },
    { to: "/transmissions", label: "Data Transmission", show: true },
    { to: "/calculations", label: "Calculations", show: true },
    { to: "/approvals", label: "Approvals", show: canApprove },
    { to: "/audit", label: "Audit Trail", show: canAudit },
    { to: "/analytics", label: "Analytics", show: canAnalytics },
  ].filter((s) => s.show);

  const tabStyle = ({ isActive }: { isActive: boolean }): React.CSSProperties => ({
    padding: "10px 12px",
    fontSize: 14,
    fontWeight: isActive ? 700 : 500,
    color: isActive ? "var(--sos-section-blue)" : "var(--sos-text-muted)",
    textDecoration: "none",
    whiteSpace: "nowrap",
    borderBottom: `3px solid ${isActive ? "var(--sos-blue)" : "transparent"}`,
    marginBottom: -1,
  });

  return (
    <div>
      <TopNav
        title={
          <>
            <BrandLogo />
            <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>DRISHTI Portal</span>
          </>
        }
        right={
          <>
            {canRobotView && (
              <a href={robotViewUrl(location.pathname)} title="Switch to the Robot View (capture & transmit)"
                style={{ border: "1px solid var(--sos-blue)", borderRadius: "var(--sos-radius-sm)", padding: "6px 12px", fontWeight: 600, fontSize: 13, textDecoration: "none", color: "var(--sos-blue)", whiteSpace: "nowrap" }}>
                Robot View ↗
              </a>
            )}
            <Badge tone="info">{session.role}</Badge>
            <span style={{ color: "var(--sos-text-muted)", whiteSpace: "nowrap" }}>{session.username}</span>
            <Button variant="ghost" onClick={signOut} style={{ whiteSpace: "nowrap" }}>Sign out</Button>
          </>
        }
      />
      <nav aria-label="Portal sections"
        style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 24px", background: "var(--sos-surface)", borderBottom: "1px solid var(--sos-border)" }}>
        {sections.map((s) => <NavLink key={s.to} to={s.to} style={tabStyle}>{s.label}</NavLink>)}
      </nav>
      <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        <Routes>
          <Route path="/" element={<Navigate to={canReview ? "/blocks" : "/capture"} />} />
          <Route path="/blocks" element={canReview ? <BlocksView role={session.role} /> : <Denied />} />
          <Route path="/capture" element={canCapture ? <CaptureView /> : <Denied />} />
          <Route path="/transmissions" element={<TransmissionView canOpenRobot={canRobotView} />} />
          <Route path="/calculations" element={<CalculationView canRetry={canApprove} />} />
          <Route path="/approvals" element={canApprove ? <ApprovalView /> : <Denied />} />
          <Route path="/audit" element={canAudit ? <AuditView /> : <Denied />} />
          <Route path="/analytics" element={canAnalytics ? <AnalyticsView /> : <Denied />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function Denied() {
  return <p style={{ color: "var(--sos-danger)" }}>You do not have access to this page.</p>;
}
