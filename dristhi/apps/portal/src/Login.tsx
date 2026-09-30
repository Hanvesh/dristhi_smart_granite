import React, { useState } from "react";
import { BrandLogo, Card, Button } from "@drishti/ui";
import { login } from "./auth";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("officer");
  const [password, setPassword] = useState("officer");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      login(username, password);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "linear-gradient(135deg, var(--sos-dark), var(--sos-section-blue))",
      }}
    >
      <Card style={{ width: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <BrandLogo variant="full" height={52} />
          <h2 style={{ margin: "16px 0 4px", color: "var(--sos-dark)" }}>DRISHTI Portal</h2>
          <p style={{ margin: 0, color: "var(--sos-text-muted)" }}>Officer &amp; Operator Sign-in</p>
        </div>
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
          </label>
          {error && <div style={{ color: "var(--sos-danger)", fontSize: 13 }}>{error}</div>}
          <Button type="submit">Sign in</Button>
        </form>
        <p style={{ fontSize: 12, color: "var(--sos-text-muted)", marginTop: 16 }}>
          Demo users: officer/officer, operator/operator, admin-user/admin
        </p>
      </Card>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 4,
  padding: "8px 10px",
  border: "1px solid var(--sos-border)",
  borderRadius: "var(--sos-radius-sm)",
  fontSize: 14,
};
