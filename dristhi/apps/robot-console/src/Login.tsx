import React, { useState } from "react";
import { BrandLogo, Card, Button } from "@drishti/ui";
import { login } from "./auth";
import { portalUrl } from "./portalLink";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("robotop");
  const [password, setPassword] = useState("robotop");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try { login(username, password); onLogin(); }
    catch (err) { setError((err as Error).message); }
  };

  const input: React.CSSProperties = {
    width: "100%", marginTop: 4, padding: "8px 10px",
    border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius-sm)", fontSize: 14,
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center",
      background: "linear-gradient(135deg, #0f1e38, var(--sos-dark))" }}>
      <Card style={{ width: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <BrandLogo height={40} />
          <h2 style={{ margin: "16px 0 4px" }}>Robot View</h2>
          <p style={{ margin: 0, color: "var(--sos-text-muted)" }}>Robot-operator sign-in · capture &amp; transmit</p>
        </div>
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Username
            <input style={input} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Password
            <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <div style={{ color: "var(--sos-danger)", fontSize: 13 }}>{error}</div>}
          <Button type="submit">Sign in</Button>
        </form>
        <p style={{ fontSize: 12, color: "var(--sos-text-muted)", marginTop: 16 }}>Demo: robotop / robotop</p>
        <a href={portalUrl()} style={{ fontSize: 13, fontWeight: 600, color: "var(--sos-blue)" }}>← Back to Portal</a>
      </Card>
    </div>
  );
}
