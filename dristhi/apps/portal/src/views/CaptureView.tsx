import React, { useRef, useState } from "react";
import {
  Card, Button, Badge, inr, inrExact, seigniorageBreakdown, classificationLabel,
  QUARRIES, Quarry, pointInQuarry, distanceToCenterM, randomPointInQuarry, quarryBounds,
} from "@drishti/ui";
import { api, FieldEstimate } from "../api";

// Granite-type options offered in the capture form. The shared quarry registry
// uses black_galaxy | colour | grey; the estimator accepts those directly.
const GRANITE_OPTIONS: { value: string; label: string }[] = [
  { value: "black_galaxy", label: "Black Galaxy" },
  { value: "colour", label: "Colour Granite" },
  { value: "grey", label: "Grey / Common" },
];

interface Gps {
  lat: number;
  lon: number;
  accM: number;
  source: "device" | "random";
  inside: boolean;
  distM: number;
}

export function CaptureView() {
  const [quarryIdx, setQuarryIdx] = useState(0);
  const [blockId, setBlockId] = useState("");
  const [graniteType, setGraniteType] = useState<string>(QUARRIES[0].type);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [gps, setGps] = useState<Gps | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [ts, setTs] = useState("");
  const [markerMm, setMarkerMm] = useState("200");
  const [markerPx, setMarkerPx] = useState("100");
  // Realistic default bounding-box pixel spans for a ~2.4 x 1.24 x 1.08 m block
  // at 0.002 m/px, so the estimate is sensible out of the box (a block edge in
  // a real photo spans hundreds–thousands of px, not tens).
  const [lPx, setLPx] = useState("1200");
  const [wPx, setWPx] = useState("620");
  const [hPx, setHPx] = useState("540");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<FieldEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const quarry: Quarry = QUARRIES[quarryIdx];
  const bounds = quarryBounds(quarry);

  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setPhotoName(f.name);
    setPreview(URL.createObjectURL(f));
    setTs(new Date().toISOString());
  };

  const applyPoint = (lat: number, lon: number, accM: number, source: "device" | "random") => {
    setGps({
      lat: +lat.toFixed(6), lon: +lon.toFixed(6), accM,
      source, inside: pointInQuarry(lat, lon, quarry), distM: distanceToCenterM(lat, lon, quarry),
    });
  };

  const captureGps = () => {
    setError(null);
    if (!navigator.geolocation) {
      setError("Geolocation not available on this device. Use ‘Random point in quarry’ instead.");
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        applyPoint(pos.coords.latitude, pos.coords.longitude, Math.round(pos.coords.accuracy), "device");
        setGpsBusy(false);
      },
      (err) => { setError(`GPS: ${err.message}`); setGpsBusy(false); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  // Generate a random lat/lon guaranteed to lie inside the selected quarry's
  // concession boundary (useful for the demo / when device GPS is unavailable).
  const randomGps = () => {
    setError(null);
    const p = randomPointInQuarry(quarry);
    applyPoint(p.lat, p.lon, 2 + Math.round(Math.random() * 3), "random");
  };

  const onQuarry = (i: number) => {
    setQuarryIdx(i);
    setGraniteType(QUARRIES[i].type);
    // Re-validate an existing point against the newly selected quarry.
    setGps((g) => (g ? { ...g, inside: pointInQuarry(g.lat, g.lon, QUARRIES[i]), distM: distanceToCenterM(g.lat, g.lon, QUARRIES[i]) } : g));
  };

  const submit = async () => {
    setError(null);
    setResult(null);
    if (!lPx || !wPx || !hPx) {
      setError("Enter the block pixel L/W/H (from the marker-scaled photo).");
      return;
    }
    // Guard against implausibly small blocks (a common input mistake: entering
    // tens of pixels instead of the real hundreds/thousands an edge spans).
    const mpp = Number(markerMm) / 1000 / Number(markerPx);
    const preL = Number(lPx) * mpp, preW = Number(wPx) * mpp, preH = Number(hPx) * mpp;
    if (Number(markerPx) <= 0 || Number(markerMm) <= 0) {
      setError("Marker size and marker pixels must be positive.");
      return;
    }
    if (preL < 0.3 || preW < 0.3 || preH < 0.3) {
      setError(`That scales to only ${preL.toFixed(2)}×${preW.toFixed(2)}×${preH.toFixed(2)} m. ` +
        `Block edges usually span hundreds of pixels — check the pixel values (or the marker px).`);
      return;
    }
    setSubmitting(true);
    const effectiveBlockId = blockId || `${quarry.code.replace("APQRY-", "QRY-")}-${900 + Math.floor(Math.random() * 99)}`;
    try {
      const res = await api.estimateField({
        granite_type: graniteType,
        marker_real_mm: Number(markerMm),
        marker_pixels: Number(markerPx),
        block_length_px: Number(lPx),
        block_width_px: Number(wPx),
        block_height_px: Number(hPx),
        block_id: effectiveBlockId,
        quarry_id: quarry.code,
        lat: gps?.lat,
        lon: gps?.lon,
      });
      setResult(res);
    } catch {
      // Offline fallback: estimate locally (still Portal-side) so the demo
      // keeps working. Nothing is persisted or sent to the robot.
      setResult(localEstimate());
      setError("Gateway unreachable — showing a local estimate (offline). It was not saved; submit again once the gateway is back.");
    } finally {
      setSubmitting(false);
    }
  };

  // Local marker-scale estimate mirroring services/vision (offline fallback).
  const localEstimate = (): FieldEstimate => {
    const mpp = Number(markerMm) / 1000 / Number(markerPx);
    const L = +(Number(lPx) * mpp).toFixed(3);
    const W = +(Number(wPx) * mpp).toFixed(3);
    const H = +(Number(hPx) * mpp).toFixed(3);
    const vol = +(L * W * H * 0.97).toFixed(4);
    const above = vol >= 2.5;
    const rates: Record<string, [number, number]> = {
      black_galaxy: [2400, 1800], colour: [2000, 1500], grey: [1600, 1200],
    };
    const density: Record<string, number> = { black_galaxy: 3.0, colour: 2.75, grey: 2.65 };
    const [rateAbove, rateBelow] = rates[graniteType] ?? rates.grey;
    const rate = above ? rateAbove : rateBelow;
    const label = GRANITE_OPTIONS.find((o) => o.value === graniteType)?.label ?? graniteType;
    return {
      method: "aruco_marker_scale_v1", metres_per_pixel: +mpp.toFixed(6),
      length_m: L, width_m: W, height_m: H, volume_m3: vol, confidence: 0.9,
      classification: above ? "above_gangsaw" : "below_gangsaw",
      granite_category: graniteType,
      category_name: `${label} (${above ? "Above" : "Below"} Gangsaw)`,
      rate_per_m3_inr: rate, tonnage_mt: +(vol * (density[graniteType] ?? 2.65)).toFixed(3),
      seigniorage_fee_inr: +(vol * rate).toFixed(2), threshold_m3: 2.5, persisted: false,
    };
  };

  const input: React.CSSProperties = {
    width: "100%", marginTop: 4, padding: "8px 10px",
    border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius-sm)", fontSize: 14,
    background: "var(--sos-surface)", boxSizing: "border-box",
  };
  const labelCls: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--sos-text-muted)" };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>New Field Capture</h2>
        <Badge tone="info">FIELD CAPTURE</Badge>
      </div>
      <p style={{ color: "var(--sos-text-muted)", margin: 0 }}>
        Photograph the block beside a reference marker, geo-tag it inside the quarry boundary, and get instant
        volume + gangsaw class + seigniorage from the Portal's vision and seigniorage services.
      </p>

      <Card style={{ display: "grid", gap: 16 }}>
        {/* Photo capture */}
        <div>
          <span style={labelCls}>Block photo (with reference marker)</span>
          <div style={{ marginTop: 6 }}>
            {preview ? (
              <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid var(--sos-border)" }}>
                <img src={preview} alt="captured block" style={{ width: "100%", maxHeight: 220, objectFit: "cover", display: "block" }} />
                <button type="button" onClick={() => { setPreview(null); setPhotoName(null); if (fileRef.current) fileRef.current.value = ""; }}
                  style={{ position: "absolute", right: 8, top: 8, background: "rgba(255,255,255,0.9)", border: "1px solid var(--sos-border)", borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                  Retake
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()}
                style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, border: "2px dashed var(--sos-border)", borderRadius: 12, background: "var(--sos-surface)", padding: "28px 0", color: "var(--sos-text-muted)", cursor: "pointer" }}>
                <span style={{ fontSize: 30 }}>📷</span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Tap to capture / upload</span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: "none" }} />
          </div>
        </div>

        {/* Quarry + block id + granite */}
        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelCls}>Quarry / extraction pit</span>
          <select value={quarryIdx} onChange={(e) => onQuarry(Number(e.target.value))} style={input}>
            {QUARRIES.map((q, i) => (
              <option key={q.code} value={i}>{q.name} — {q.district} ({q.code})</option>
            ))}
          </select>
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelCls}>Block ID (optional — auto if blank)</span>
            <input value={blockId} onChange={(e) => setBlockId(e.target.value)} placeholder="auto" style={input} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelCls}>Granite type</span>
            <select value={graniteType} onChange={(e) => setGraniteType(e.target.value)} style={input}>
              {GRANITE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        {/* GPS + quarry boundary */}
        <div style={{ border: "1px solid var(--sos-border)", borderRadius: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={labelCls}>GPS geo-tag (within quarry boundary)</span>
            <span style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={captureGps} disabled={gpsBusy}>{gpsBusy ? "Locating…" : "📍 Capture GPS"}</Button>
              <Button variant="ghost" onClick={randomGps}>🎲 Random in quarry</Button>
            </span>
          </div>

          {gps ? (
            <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--sos-text)" }}>
                {gps.lat}, {gps.lon} (±{gps.accM}m) · {gps.source === "random" ? "random" : "device"}
              </div>
              <div>
                {gps.inside
                  ? <Badge tone="success">✓ Inside {quarry.code} boundary ({gps.distM} m from centre)</Badge>
                  : <Badge tone="danger">⚠ Outside boundary ({gps.distM} m from centre)</Badge>}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--sos-text-muted)" }}>not geo-tagged</div>
          )}

          <div style={{ marginTop: 8, fontSize: 10.5, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>
            Boundary: lat [{bounds.minLat}, {bounds.maxLat}] · lon [{bounds.minLon}, {bounds.maxLon}]
          </div>
          {ts && <div style={{ marginTop: 4, fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--sos-text-muted)" }}>📅 {ts}</div>}
          {photoName && <div style={{ marginTop: 4, fontSize: 11, color: "var(--sos-text-muted)" }}>📎 {photoName}</div>}
        </div>

        {/* Reference marker + measured pixels */}
        <div style={{ border: "1px solid var(--sos-border)", borderRadius: 12, padding: 12 }}>
          <span style={labelCls}>Reference marker &amp; measured pixels</span>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>MARKER SIZE (mm)</span>
              <input type="number" value={markerMm} onChange={(e) => setMarkerMm(e.target.value)} style={input} />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>MARKER (px)</span>
              <input type="number" value={markerPx} onChange={(e) => setMarkerPx(e.target.value)} style={input} />
            </label>
          </div>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {([["LENGTH (px)", lPx, setLPx], ["WIDTH (px)", wPx, setWPx], ["HEIGHT (px)", hPx, setHPx]] as const).map(
              ([lbl, val, set]) => (
                <label key={lbl} style={{ display: "grid", gap: 2 }}>
                  <span style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>{lbl}</span>
                  <input type="number" value={val} onChange={(e) => set(e.target.value)} placeholder="0" style={input} />
                </label>
              ),
            )}
          </div>
          {(() => {
            const mpp = Number(markerMm) / 1000 / Number(markerPx || 1);
            const dl = Number(lPx) * mpp, dw = Number(wPx) * mpp, dh = Number(hPx) * mpp;
            const small = dl < 0.3 || dw < 0.3 || dh < 0.3;
            return (
              <div style={{ marginTop: 8, borderRadius: 8, background: "var(--sos-light)", padding: "8px 10px", fontFamily: "ui-monospace, monospace", fontSize: 11, color: small ? "var(--sos-danger)" : "var(--sos-text-muted)" }}>
                Scale: {Number.isFinite(mpp) ? mpp.toFixed(5) : "—"} m/px → block ≈ {dl.toFixed(2)} × {dw.toFixed(2)} × {dh.toFixed(2)} m
                {small && " ⚠ too small — pixel edges usually span hundreds of px"}
              </div>
            );
          })()}
          <p style={{ marginTop: 8, marginBottom: 0, fontSize: 11, color: "var(--sos-text-muted)" }}>
            The on-device CV step detects the ArUco marker and block edges; enter the measured pixels here for the demo.
          </p>
        </div>

        {error && (
          <p style={{ margin: 0, border: "1px solid var(--sos-danger)", background: "rgba(255,77,79,0.08)", color: "var(--sos-danger)", padding: "8px 12px", borderRadius: 8, fontSize: 13 }}>
            {error}
          </p>
        )}

        <Button onClick={submit} disabled={submitting}>
          {submitting ? "Estimating…" : "Estimate volume & seigniorage"}
        </Button>
      </Card>

      {result && <ResultCard result={result} quarry={quarry} gps={gps} ts={ts} />}
    </div>
  );
}

function ResultCard({ result, quarry, gps, ts }: {
  result: FieldEstimate;
  quarry: Quarry;
  gps: Gps | null;
  ts: string;
}) {
  const above = result.classification === "above_gangsaw";
  const sb = seigniorageBreakdown(result.seigniorage_fee_inr);
  const box: React.CSSProperties = { border: "1px solid var(--sos-border)", borderRadius: 8, padding: 8, textAlign: "center" };
  return (
    <Card style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>ESTIMATE · {result.method}</span>
        <Badge tone={above ? "success" : "info"}>{classificationLabel(result.classification)}</Badge>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {([["L", result.length_m], ["W", result.width_m], ["H", result.height_m]] as const).map(([k, v]) => (
          <div key={k} style={box}>
            <div style={{ fontSize: 9, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>{k} (m)</div>
            <div style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", border: "1px solid var(--sos-border)", borderRadius: 8, padding: "8px 12px" }}>
        <span style={{ color: "var(--sos-text-muted)", fontSize: 13 }}>Volume</span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "var(--sos-blue)" }}>{result.volume_m3} m³</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", border: "1px solid var(--sos-border)", borderRadius: 8, padding: "8px 12px" }}>
        <span style={{ color: "var(--sos-text-muted)", fontSize: 13 }}>Tonnage (MT basis)</span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{result.tonnage_mt} MT</span>
      </div>

      <div style={{ border: "1px solid var(--sos-border)", borderRadius: 12, padding: 12, background: "var(--sos-light)", display: "grid", gap: 4 }}>
        <div style={{ fontSize: 11, letterSpacing: 0.5, color: "var(--sos-text-muted)", marginBottom: 4 }}>
          {result.category_name} · SEIGNIORAGE (FORM-M)
        </div>
        <BreakRow label={`Base seigniorage (@ ${inr(result.rate_per_m3_inr)}/m³)`} value={inrExact(sb.base)} />
        <BreakRow label="District Mineral Foundation (DMF 10%)" value={inrExact(sb.dmf)} />
        <BreakRow label="National Mineral Explr. Trust (NMET 2%)" value={inrExact(sb.nmet)} />
        <div style={{ borderTop: "1px solid var(--sos-border)", paddingTop: 4 }}>
          <BreakRow label="Total challan payable" value={inrExact(sb.total)} bold />
        </div>
      </div>

      <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--sos-text-muted)" }}>
        {quarry.code} · {gps ? `${gps.lat},${gps.lon} ${gps.inside ? "✓ inside" : "⚠ outside"}` : "no GPS"} ·{" "}
        {ts || new Date().toISOString()} · conf {Math.round(result.confidence * 100)}%
        {result.persisted ? " · saved for approval" : ""}
      </div>
    </Card>
  );
}

function BreakRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
      <span style={{ color: "var(--sos-text-muted)" }}>{label}</span>
      <span style={{ fontWeight: bold ? 700 : 500, fontFamily: "ui-monospace, monospace" }}>{value}</span>
    </div>
  );
}
