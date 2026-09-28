import React, { useEffect, useState } from "react";
import { Routes, Route, Link, useNavigate, Navigate } from "react-router-dom";
import { BrandLogo, TopNav, Button, Badge } from "@drishti/ui";
import { getSession, logout, Session } from "./auth";
import { Login } from "./Login";
import { BlocksView } from "./views/BlocksView";
import { AnalyticsView } from "./views/AnalyticsView";
import { CaptureView } from "./views/CaptureView";
import { AuditView } from "./views/AuditView";

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const navigate = useNavigate();

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

  return (
    <div>
      <TopNav
        title={
          <>
            <BrandLogo />
            <span style={{ fontWeight: 700 }}>DRISHTI Portal</span>
            <nav style={{ display: "flex", gap: 16, marginLeft: 24 }}>
              {canReview && <Link to="/blocks">Blocks</Link>}
              {canCapture && <Link to="/capture">New Capture</Link>}
              {canAudit && <Link to="/audit">Audit Trail</Link>}
              {canAnalytics && <Link to="/analytics">Analytics</Link>}
            </nav>
          </>
        }
        right={
          <>
            <Badge tone="info">{session.role}</Badge>
            <span style={{ color: "var(--sos-text-muted)" }}>{session.username}</span>
            <Button variant="ghost" onClick={signOut}>Sign out</Button>
          </>
        }
      />
      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        <Routes>
          <Route path="/" element={<Navigate to={canReview ? "/blocks" : "/capture"} />} />
          <Route path="/blocks" element={canReview ? <BlocksView role={session.role} /> : <Denied />} />
          <Route path="/capture" element={canCapture ? <CaptureView /> : <Denied />} />
          <Route path="/audit" element={canAudit ? <AuditView /> : <Denied />} />
          <Route path="/analytics" element={canAnalytics ? <AnalyticsView /> : <Denied />} />
        </Routes>
      </main>
    </div>
  );
}

function Denied() {
  return <p style={{ color: "var(--sos-danger)" }}>You do not have access to this page.</p>;
}
