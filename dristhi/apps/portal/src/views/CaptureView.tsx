import React, { useState } from "react";
import { Card, Button, Badge } from "@drishti/ui";
import { api } from "../api";

export function CaptureView() {
  const [blockId, setBlockId] = useState("QRY-AMR-2026-0999");
  const [quarry, setQuarry] = useState("APQRY-0023");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const payload = {
      block_id: blockId,
      quarry_id: quarry,
      source: "mobile",
      gps: { lat: 16.5734, lon: 80.3567, accuracy_cm: 300 },
      // In the real app this would be an uploaded image reference; the vision
      // service estimates dimensions. Here we submit metadata only.
    };
    try {
      const block = await api.submitCapture(payload);
      setResult(block);
    } catch (e) {
      setError("Gateway not reachable — this form posts to POST /captures when the backend is running.");
    }
  };

  const input: React.CSSProperties = {
    width: "100%", marginTop: 4, padding: "8px 10px",
    border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius-sm)",
  };

  return (
    <Card style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>New Field Capture</h2>
      <p style={{ color: "var(--sos-text-muted)" }}>
        Submit a granite block for AI measurement. The mobile app auto-fills GPS, timestamp and
        image; this web form is for supervised/manual entry.
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ fontWeight: 600, fontSize: 13 }}>
          Block ID
          <input style={input} value={blockId} onChange={(e) => setBlockId(e.target.value)} />
        </label>
        <label style={{ fontWeight: 600, fontSize: 13 }}>
          Quarry ID
          <input style={input} value={quarry} onChange={(e) => setQuarry(e.target.value)} />
        </label>
        <Button onClick={submit}>Submit for measurement</Button>
      </div>
      {error && <p style={{ color: "var(--sos-warning)", marginTop: 16 }}>{error}</p>}
      {result && (
        <div style={{ marginTop: 16 }}>
          <Badge tone="success">Measured</Badge>
          <pre style={{ background: "var(--sos-light)", padding: 12, borderRadius: 8, overflow: "auto" }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </Card>
  );
}
