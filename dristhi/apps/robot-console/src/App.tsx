import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandLogo } from "@drishti/ui";
import { getSession, logout, Session } from "./auth";
import { Login } from "./Login";
import { SceneView, SceneHandle } from "./SceneView";
import { BatteryGauge } from "./BatteryGauge";
import { DEPLOY_SITES, DEVICE_ID, LIDAR_SENSOR, SurveyBlock, buildBlocks, captureBlock } from "./simWorld";
import { LinkInfo, SecureLink, secureContextAvailable } from "./secureLink";
import { portalUrl, rememberReturnPath } from "./portalLink";

// Robot View: the rover captures raw sensor data and transmits it over the
// secure robot link. It computes nothing about the block's value: volume,
// gangsaw class, seigniorage, OMEPS reconciliation and approvals all happen
// in the Portal (gateway pipeline), which the operator can jump back to.

const BRAND = "#702cf6";
const BORDER = "#e5e2ec";
const PANEL = "#f6f5fb";
const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api";
const DRAIN_PER_SCAN = 4; // battery % per scan; a full pack covers the pit

type SurveyStatus = "IDLE" | "IN_PROGRESS" | "COMPLETED";
type LinkState = "connecting" | "active" | "error" | "unavailable";
interface LogEntry { id: number; time: string; message: string; emphasis: boolean; }

rememberReturnPath();

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  if (!session) return <Login onLogin={() => setSession(getSession())} />;
  return <Dashboard session={session} onSignOut={() => { logout(); setSession(null); }} />;
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const secureOk = secureContextAvailable();
  const [siteIdx, setSiteIdx] = useState(0);
  const [blocks, setBlocks] = useState<SurveyBlock[]>([]);
  const [battery, setBattery] = useState(100);
  const [status, setStatus] = useState<SurveyStatus>("IDLE");
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [linkInfo, setLinkInfo] = useState<LinkInfo | null>(null);
  const [linkState, setLinkState] = useState<LinkState>(secureOk ? "connecting" : "unavailable");
  const [linkError, setLinkError] = useState<string | null>(
    secureOk ? null : "WebCrypto requires HTTPS or localhost. Captures are held on the robot; nothing is sent in plaintext.");
  const [batteryResetting, setBatteryResetting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [, setTick] = useState(0);

  const sceneRef = useRef<SceneHandle>(null);
  const blocksRef = useRef<SurveyBlock[]>([]);
  const autoRef = useRef(false);
  const busyRef = useRef(false);
  const batteryRef = useRef(100);
  const stepRef = useRef<() => void>(() => undefined);
  const linkStarted = useRef(false);
  useEffect(() => { batteryRef.current = battery; }, [battery]);

  const site = DEPLOY_SITES[siteIdx];

  const link = useMemo(() => new SecureLink({
    base: API_BASE, deviceId: DEVICE_ID,
    getToken: () => getSession()?.token ?? null,
    onChange: (info) => setLinkInfo(info),
  }), []);

  const log = useCallback((message: string, emphasis = false) => {
    const time = new Date().toLocaleTimeString("en-IN", { hour12: false });
    setLogs((p) => [{ id: Date.now() + Math.random(), time, message, emphasis }, ...p].slice(0, 60));
  }, []);

  const commit = useCallback((next: SurveyBlock[]) => {
    blocksRef.current = next;
    setBlocks(next);
    sceneRef.current?.setBlocks(next);
  }, []);

  const patchBlock = useCallback((blockId: string, patch: Partial<SurveyBlock>) => {
    commit(blocksRef.current.map((b) => (b.blockId === blockId ? { ...b, ...patch } : b)));
  }, [commit]);

  const openLink = useCallback(async () => {
    if (!secureContextAvailable()) return false;
    setLinkState("connecting");
    try {
      const info = await link.connect();
      setLinkState("active");
      setLinkError(null);
      log(`Secure link established · ${info.kdf} → AES-256-GCM · key ${info.kid.slice(0, 8)}… · ` +
        `expires in ${Math.round((info.expiresAt - Date.now()) / 60000)} min`, true);
      return true;
    } catch (e) {
      setLinkState("error");
      setLinkError((e as Error).message);
      log(`Secure link unavailable: ${(e as Error).message}. Captures will be held on the robot.`, true);
      return false;
    }
  }, [link, log]);

  useEffect(() => {
    if (linkStarted.current) return; // StrictMode double-mount guard
    linkStarted.current = true;
    openLink();
  }, [openLink]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000); // key-expiry countdown
    return () => clearInterval(t);
  }, []);

  const loadSite = useCallback((i: number) => {
    const s = DEPLOY_SITES[i];
    const bs = buildBlocks(s);
    commit(bs);
    setStatus("IDLE"); setAuto(false); autoRef.current = false; setDetailId(null);
    sceneRef.current?.returnHome();
    log(`RTK fix acquired at ${s.name} (${s.code}). ${bs.length} blocks detected by the perception stack.`, true);
  }, [commit, log]);

  useEffect(() => {
    const id = setTimeout(() => loadSite(0), 250); // after the scene mounts
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Seal + send one block's raw capture. Failures stay on the robot for retry. */
  const transmit = useCallback(async (block: SurveyBlock): Promise<boolean> => {
    if (!block.capture) return false;
    patchBlock(block.blockId, { status: "SENDING", transmission: { state: "sending", at: new Date().toISOString() } });
    try {
      const { receipt, header, bytes } = await link.transmit("capture", block.capture);
      setLinkState("active");
      setLinkError(null);
      patchBlock(block.blockId, {
        status: "TRANSMITTED", envelopeHeader: header,
        transmission: { state: receipt.status, receiptId: receipt.receipt_id, seq: receipt.seq, kid: receipt.kid,
          msgId: String(header.jti), bytes, at: receipt.received_at },
      });
      log(`${block.blockId}: raw capture ${receipt.status === "duplicate" ? "already on file at the Portal" : "delivered"} · ` +
        `seq ${receipt.seq} · ${bytes} B sealed`, true);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setLinkState(secureContextAvailable() ? "error" : "unavailable");
      setLinkError(msg);
      patchBlock(block.blockId, { status: "FAILED", transmission: { state: "failed", at: new Date().toISOString(), error: msg } });
      log(`${block.blockId}: transmission failed (${msg}). Capture kept on the robot for retry.`, true);
      return false;
    }
  }, [link, log, patchBlock]);

  const canStep = () => blocksRef.current.some((b) => b.status === "DETECTED") && batteryRef.current > 5;

  const stepOnce = useCallback(async () => {
    if (busyRef.current || !canStep()) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("IN_PROGRESS");
    const block = blocksRef.current
      .filter((b) => b.status === "DETECTED")
      .sort((a, b) => a.blockId.localeCompare(b.blockId))[0];

    log(`Navigating to ${block.blockId} via RTK-GNSS…`);
    patchBlock(block.blockId, { status: "SCANNING" });
    await sceneRef.current?.driveToAndScan(block.blockId);

    const capture = await captureBlock(block, site, batteryRef.current);
    const l = capture.sensor.lidar;
    patchBlock(block.blockId, { capture, dimensions: { lengthM: l.extent_x_m, widthM: l.extent_y_m, heightM: l.extent_z_m } });
    setBattery((b) => Math.max(0, b - DRAIN_PER_SCAN));
    log(`${block.blockId}: LiDAR ${l.point_count.toLocaleString("en-IN")} pts in ${l.scan_ms} ms · ` +
      `extents ${l.extent_x_m} × ${l.extent_y_m} × ${l.extent_z_m} m · RGB frame hashed · GNSS RTK fixed`);
    await transmit({ ...block, capture });

    busyRef.current = false;
    setBusy(false);
    if (!blocksRef.current.some((b) => b.status === "DETECTED")) {
      setStatus("COMPLETED"); setAuto(false); autoRef.current = false;
      await sceneRef.current?.returnHome();
      const sent = blocksRef.current.filter((b) => b.status === "TRANSMITTED").length;
      log(`Survey complete. ${sent}/${blocksRef.current.length} raw captures delivered to the Portal for calculation.`, true);
    } else if (autoRef.current) {
      setTimeout(() => stepRef.current(), 350);
    }
  }, [site, log, patchBlock, transmit]);
  useEffect(() => { stepRef.current = () => { void stepOnce(); }; }, [stepOnce]);

  const toggleAuto = () => {
    if (autoRef.current) { setAuto(false); autoRef.current = false; log("Survey paused by operator."); return; }
    setAuto(true); autoRef.current = true;
    if (status !== "IN_PROGRESS") {
      setStatus("IN_PROGRESS");
      log(`Autonomous survey started at ${site.code} · ${blocksRef.current.length} blocks queued.`, true);
    }
    if (!busyRef.current) stepRef.current();
  };

  const retryFailed = async () => {
    const pending = blocksRef.current.filter((b) => b.status === "FAILED" && b.capture);
    if (!pending.length) return;
    setRetrying(true);
    if (!link.info()) await openLink();
    for (const b of pending) await transmit(b);
    setRetrying(false);
  };

  const onSelectSite = (i: number) => { setSiteIdx(i); setBattery(100); loadSite(i); };

  const resetBattery = () => {
    setBatteryResetting(true);
    setTimeout(() => {
      setBattery(100);
      setBatteryResetting(false);
      log("Battery pack hot-swapped. Charge reset to 100%.", true);
    }, 500);
  };

  const signOut = async () => { await link.close(); onSignOut(); };

  // Derived (operational counts only).
  const captured = blocks.filter((b) => b.capture).length;
  const delivered = blocks.filter((b) => b.status === "TRANSMITTED").length;
  const failed = blocks.filter((b) => b.status === "FAILED").length;
  const last = blocks.filter((b) => b.capture)
    .sort((a, b) => b.capture!.captured_at.localeCompare(a.capture!.captured_at))[0] ?? null;
  const detail = blocks.find((b) => b.blockId === detailId) ?? null;
  const expiresMs = linkInfo ? Math.max(0, linkInfo.expiresAt - Date.now()) : 0;
  const keyIdle = !!linkInfo && expiresMs === 0;

  return (
    <div style={{ minHeight: "100vh", background: "#f2f1f7", color: "#111827" }}>
      {/* Top bar */}
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,0.85)", padding: "10px 16px", backdropFilter: "blur(6px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
          <a href={portalUrl()} style={backLink} title="Return to the DRISHTI Portal">← Back to Portal</a>
          <BrandLogo height={26} />
          <span style={{ fontWeight: 700 }}>Robot View</span>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#9ca3af" }}>CAPTURE &amp; TRANSMIT ONLY</span>
          <select
            aria-label="Deployment site"
            value={siteIdx}
            onChange={(e) => onSelectSite(Number(e.target.value))}
            disabled={busy}
            style={{ maxWidth: 340, borderRadius: 8, border: `1px solid ${BORDER}`, background: "#fff", padding: "6px 10px", fontSize: 13, fontWeight: 600, color: "#111827" }}
          >
            {DEPLOY_SITES.map((q, i) => (
              <option key={q.code} value={i}>{q.name} — {q.district} ({q.code})</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <LinkChip state={linkState} idle={keyIdle} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, border: "1px solid #bbf7d0", background: "#f0fdf4", padding: "4px 12px", fontSize: 10, fontFamily: "ui-monospace, monospace", fontWeight: 600, color: "#16a34a" }}>
            <span style={{ height: 6, width: 6, borderRadius: 999, background: "#22c55e" }} />
            {DEVICE_ID}: {status}
          </span>
          <span style={{ borderRadius: 999, border: `1px solid ${BORDER}`, background: "#fff", padding: "4px 12px", fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#4b5563" }}>⚡ {battery}%</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, borderRadius: 999, border: `1px solid ${BORDER}`, background: "#fff", padding: "4px 10px" }}>
            <span aria-hidden style={{ display: "flex", height: 24, width: 24, alignItems: "center", justifyContent: "center", borderRadius: 999, background: BRAND, fontSize: 12, fontWeight: 700, color: "#fff" }}>{session.username.charAt(0).toUpperCase()}</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{session.username}</span>
            <span style={{ fontSize: 9, fontFamily: "ui-monospace, monospace", color: "#6b7280", textTransform: "uppercase" }}>{session.role}</span>
            <button onClick={signOut} style={ghostBtn}>Sign out</button>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1240, margin: "0 auto", padding: 16, display: "grid", gap: 16 }}>
        {(linkState === "error" || linkState === "unavailable") && linkError && (
          <div role="alert" style={{ borderRadius: 12, border: "1px solid #fecaca", background: "#fef2f2", color: "#b91c1c", padding: "10px 14px", fontSize: 13 }}>
            <b>Secure link down.</b> {linkError}
          </div>
        )}

        {/* KPI row: operational only */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Kpi label="CAPTURED" value={`${captured}`} sub={`of ${blocks.length} detected in pit`} />
          <Kpi label="DELIVERED TO PORTAL" value={`${delivered}`} sub="receipts from gateway" accent={BRAND} />
          <Kpi label="HELD ON ROBOT" value={`${failed}`} sub="awaiting retransmission" accent={failed ? "#dc2626" : "#111827"} />
          <Kpi label="SESSION KEY" value={linkInfo && !keyIdle ? fmtCountdown(expiresMs) : "—"} sub={linkInfo ? `${linkInfo.messages}/${linkInfo.maxMessages} msgs · AES-256-GCM` : "no active key"} />
          <Kpi label="ROVER BATTERY" value={`${battery}%`} sub={DEVICE_ID} accent={battery <= 20 ? "#dc2626" : "#16a34a"} />
        </div>

        {/* Scene + right column */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 400px", gap: 16 }}>
          <section style={panel} aria-label="Optical and LiDAR view">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${BORDER}`, padding: "10px 16px" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>🎥 Primary Optical &amp; LiDAR Reticle</span>
              <span style={{ borderRadius: 6, border: "1px solid #ddd6fe", background: "#f5f3ff", padding: "2px 8px", fontSize: 10, fontFamily: "ui-monospace, monospace", color: BRAND }}>STEREO RGB-D · 30 FPS</span>
            </div>
            <div style={{ position: "relative", height: 440, background: "#eef0f4" }}>
              <SceneView ref={sceneRef} onBlockClick={(id) => setDetailId(id)} />
              <div style={{ pointerEvents: "none", position: "absolute", left: 12, top: 12, borderRadius: 8, border: `1px solid ${BORDER}`, background: "rgba(255,255,255,0.85)", padding: "8px 12px", fontFamily: "ui-monospace, monospace", fontSize: 10, color: "#4b5563" }}>
                <div style={{ fontWeight: 600, color: BRAND }}>◧ ROBOT DEPTH SCANNER</div>
                <div style={{ marginTop: 4 }}>Sensor: {LIDAR_SENSOR}</div>
                <div>Point rate: 48,200 pts/sec</div>
                <div>GNSS: RTK fixed</div>
              </div>
              <div style={{ pointerEvents: "none", position: "absolute", right: 12, top: 12, display: "flex", gap: 12, borderRadius: 8, border: `1px solid ${BORDER}`, background: "rgba(255,255,255,0.85)", padding: "8px 12px", fontFamily: "ui-monospace, monospace", fontSize: 10, color: "#6b7280" }}>
                <span>DETECTED</span><span style={{ color: "#ea580c" }}>SCANNING</span>
                <span style={{ color: BRAND }}>DELIVERED</span><span style={{ color: "#dc2626" }}>HELD</span>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, borderTop: `1px solid ${BORDER}`, background: PANEL, padding: "12px 16px" }}>
              <button onClick={toggleAuto} disabled={!auto && (busy || !canStep())} style={primaryBtn(!auto && (busy || !canStep()))}>
                {auto ? "⏸ Pause survey" : status === "IN_PROGRESS" ? "▶ Resume autonomous survey" : "▶ Start autonomous survey"}
              </button>
              <button onClick={() => { if (!auto) void stepOnce(); }} disabled={auto || busy || !canStep()} style={outlineBtn(auto || busy || !canStep())}>Scan next block</button>
              <button onClick={retryFailed} disabled={!failed || retrying} style={outlineBtn(!failed || retrying)}>
                {retrying ? "Retransmitting…" : `⟳ Retransmit held (${failed})`}
              </button>
              <span style={{ marginLeft: "auto", fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#6b7280" }}>
                Raw readings only · volume, class &amp; fees are calculated in the Portal
              </span>
            </div>
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Last raw capture */}
            <section style={{ ...panel, padding: 16 }} aria-label="Last raw capture">
              <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", letterSpacing: 1.5, color: "#6b7280" }}>LAST RAW CAPTURE</div>
              <div style={{ marginTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 19, fontWeight: 700 }}>{last?.blockId ?? "—"}</span>
                {last && <TxChip block={last} />}
              </div>
              {last?.capture ? (
                <>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {([["X", last.capture.sensor.lidar.extent_x_m], ["Y", last.capture.sensor.lidar.extent_y_m], ["Z", last.capture.sensor.lidar.extent_z_m]] as const).map(([k, v]) => (
                      <div key={k} style={{ borderRadius: 8, border: `1px solid ${BORDER}`, background: PANEL, padding: 8, textAlign: "center" }}>
                        <div style={{ fontSize: 9, fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>EXTENT {k} (m)</div>
                        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 15, fontWeight: 700 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gap: 2 }}>
                    <Row label="LiDAR points / scan time" value={`${last.capture.sensor.lidar.point_count.toLocaleString("en-IN")} · ${last.capture.sensor.lidar.scan_ms} ms`} />
                    <Row label="GNSS fix" value={`${last.capture.sensor.gnss.lat}, ${last.capture.sensor.gnss.lon} ±${last.capture.sensor.gnss.accuracy_m} m`} />
                    <Row label="RGB frame SHA-256" value={`${last.capture.sensor.camera.frame_sha256.slice(0, 16)}…`} />
                    <Row label="Captured at" value={new Date(last.capture.captured_at).toLocaleTimeString("en-IN", { hour12: false })} />
                    {last.transmission?.seq != null && <Row label="Envelope seq / size" value={`${last.transmission.seq} · ${last.transmission.bytes} B`} />}
                    {last.transmission?.receiptId && <Row label="Gateway receipt" value={`${last.transmission.receiptId.slice(0, 13)}…`} />}
                    {last.transmission?.error && <Row label="Last error" value={last.transmission.error} />}
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {last.status === "TRANSMITTED" && (
                      <a href={portalUrl("/calculations", { calc: last.capture.capture_id })} style={{ ...linkBtn, background: BRAND, color: "#fff", border: "none" }}>
                        Open calculation in Portal ↗
                      </a>
                    )}
                    <button onClick={() => setDetailId(last.blockId)} style={outlineBtn(false)}>View transmitted payload</button>
                  </div>
                </>
              ) : (
                <p style={{ marginTop: 16, fontSize: 12.5, color: "#6b7280" }}>No capture yet. Start the survey; each scan is sealed and sent to the Portal, which does all the calculations.</p>
              )}
            </section>

            {/* Secure link */}
            <section style={{ ...panel, padding: 16 }} aria-label="Secure link">
              <div style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>🔒 Secure Robot Link</h3>
                <LinkChip state={linkState} idle={keyIdle} />
              </div>
              <Row label="Protocol" value="drishti-robot-link/v1" />
              <Row label="Key agreement" value="ECDH P-256 → HKDF-SHA256" />
              <Row label="Envelope" value="JWE compact · dir · A256GCM" />
              <Row label="Replay guard" value="single-use jti + seq · ±5 min iat" />
              <Row label="Session key id" value={linkInfo ? `${linkInfo.kid.slice(0, 12)}…` : "—"} />
              <Row label="Expires in" value={linkInfo ? (keyIdle ? "expired · re-keys on next send" : fmtCountdown(expiresMs)) : "—"} />
              <Row label="Messages / last seq" value={linkInfo ? `${linkInfo.messages}/${linkInfo.maxMessages} · ${linkInfo.lastSeq}` : "—"} />
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => void openLink()} disabled={!secureOk || linkState === "connecting"} style={outlineBtn(!secureOk || linkState === "connecting")}>⟳ Re-key now</button>
                <a href={portalUrl("/transmissions")} style={linkBtn}>Transmission log in Portal ↗</a>
              </div>
            </section>

            {/* Robot control */}
            <section style={{ ...panel, padding: 16 }} aria-label="Robot fleet control">
              <div style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Robot Fleet Control</h3>
                <span style={{ borderRadius: 6, border: `1px solid ${BORDER}`, background: PANEL, padding: "2px 8px", fontSize: 9, fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>{DEVICE_ID}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <BatteryGauge percent={battery} size={110} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
                    <div style={{ borderRadius: 8, border: `1px solid ${BORDER}`, background: PANEL, padding: 8 }}>
                      <div style={{ color: "#6b7280" }}>STATUS</div>
                      <div>{status}</div>
                    </div>
                    <div style={{ borderRadius: 8, border: `1px solid ${BORDER}`, background: PANEL, padding: 8 }}>
                      <div style={{ color: "#6b7280" }}>CAPTURED</div>
                      <div>{captured}/{blocks.length}</div>
                    </div>
                  </div>
                  <button onClick={resetBattery} disabled={batteryResetting} style={{ marginTop: 8, width: "100%", borderRadius: 8, border: "1px solid #fed7aa", background: "#fff7ed", padding: "9px 0", fontSize: 12, fontWeight: 600, color: "#ea580c", cursor: batteryResetting ? "default" : "pointer", opacity: batteryResetting ? 0.5 : 1 }}>
                    {batteryResetting ? "Swapping pack…" : "⟳ Reset Battery to 100%"}
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Activity + capture ledger */}
        <div style={{ display: "grid", gridTemplateColumns: "380px minmax(0, 1fr)", gap: 16 }}>
          <section style={{ ...panel, padding: 16 }} aria-label="Rover activity stream">
            <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>Rover Activity Stream</h3>
            <ul aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 256, overflowY: "auto", fontSize: 12, fontFamily: "ui-monospace, monospace", color: "#4b5563" }}>
              {logs.length === 0 && <li style={{ color: "#6b7280" }}>Awaiting rover telemetry…</li>}
              {logs.map((l) => (
                <li key={l.id} style={{ borderBottom: `1px solid ${BORDER}`, padding: "4px 0", color: l.emphasis ? "#1f2937" : undefined }}>
                  <b style={{ fontWeight: l.emphasis ? 700 : 500 }}>{l.time}</b> · {l.message}
                </li>
              ))}
            </ul>
          </section>

          <section style={{ ...panel, padding: 16 }} aria-label="Capture and transmission ledger">
            <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>Capture &amp; Transmission Ledger</h3>
            <div style={{ maxHeight: 256, overflowY: "auto" }}>
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", fontFamily: "ui-monospace, monospace", fontSize: 10, letterSpacing: 0.5, color: "#6b7280" }}>
                    <th scope="col" style={{ padding: "8px 0" }}>BLOCK REF</th><th scope="col">RAW EXTENTS X×Y×Z (m)</th><th scope="col">POINTS</th>
                    <th scope="col">SEQ</th><th scope="col">STATUS</th><th scope="col">RECEIPT</th>
                  </tr>
                </thead>
                <tbody style={{ fontFamily: "ui-monospace, monospace" }}>
                  {blocks.map((b) => {
                    const l = b.capture?.sensor.lidar;
                    return (
                      <tr key={b.blockId} onClick={() => setDetailId(b.blockId)} style={{ cursor: "pointer", borderTop: `1px solid ${BORDER}` }}>
                        <td style={{ padding: "8px 0", color: BRAND }}>{b.blockId}</td>
                        <td style={{ color: "#4b5563" }}>{l ? `${l.extent_x_m}×${l.extent_y_m}×${l.extent_z_m}` : "—"}</td>
                        <td style={{ color: "#4b5563" }}>{l ? l.point_count.toLocaleString("en-IN") : "—"}</td>
                        <td style={{ color: "#4b5563" }}>{b.transmission?.seq ?? "—"}</td>
                        <td><TxChip block={b} /></td>
                        <td style={{ color: "#4b5563" }}>{b.transmission?.receiptId ? `${b.transmission.receiptId.slice(0, 8)}…` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 8, fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>
              {blocks.length} blocks · {site.district} · captures leave the robot only as AES-256-GCM envelopes
            </p>
          </section>
        </div>
      </main>

      {/* What left the robot for one block */}
      {detail && (
        <div onClick={() => setDetailId(null)} style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(17,24,39,0.4)", padding: 16, backdropFilter: "blur(4px)" }}>
          <div role="dialog" aria-modal="true" aria-labelledby="payload-title" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "80vh", overflowY: "auto", borderRadius: 16, border: "1px solid #ddd6fe", background: "#fff", padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${BORDER}`, paddingBottom: 12 }}>
              <div>
                <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", letterSpacing: 1.5, color: "#6b7280" }}>TRANSMITTED PAYLOAD (PLAINTEXT BEFORE SEALING)</div>
                <span id="payload-title" style={{ fontFamily: "ui-monospace, monospace", fontSize: 16, fontWeight: 600 }}>{detail.blockId}</span>
              </div>
              <button aria-label="Close" onClick={() => setDetailId(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 24, lineHeight: 1 }}>×</button>
            </div>
            {detail.capture ? (
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: 11.5, lineHeight: 1.6, color: "#374151", margin: 0 }}>
                {JSON.stringify({ raw_capture: detail.capture, jwe_protected_header: detail.envelopeHeader ?? null, transmission: detail.transmission ?? null }, null, 2)}
              </pre>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>Not captured yet. The rover has only detected this block.</p>
            )}
            <p style={{ marginTop: 12, marginBottom: 0, fontSize: 11, color: "#6b7280" }}>
              The session key is non-extractable inside WebCrypto and never shown or sent. No calculated values exist on the robot.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────

function fmtCountdown(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const panel: React.CSSProperties = {
  borderRadius: 16, border: `1px solid ${BORDER}`, background: "#fff",
  boxShadow: "0 1px 2px rgba(16,24,40,0.04)", overflow: "hidden",
};
const ghostBtn: React.CSSProperties = {
  marginLeft: 4, borderRadius: 6, border: `1px solid ${BORDER}`, background: "#fff",
  padding: "2px 8px", fontSize: 11, fontWeight: 600, color: "#4b5563", cursor: "pointer",
};
const backLink: React.CSSProperties = {
  borderRadius: 8, border: `1px solid ${BRAND}`, background: "#f5f3ff", padding: "6px 12px",
  fontSize: 12, fontWeight: 700, color: BRAND, textDecoration: "none", whiteSpace: "nowrap",
};
const linkBtn: React.CSSProperties = {
  display: "inline-block", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#fff", padding: "9px 14px",
  fontSize: 12, fontWeight: 600, color: BRAND, textDecoration: "none",
};
const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  borderRadius: 8, border: "none", background: BRAND, padding: "9px 16px",
  fontSize: 12, fontWeight: 600, color: "#fff", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
});
const outlineBtn = (disabled: boolean): React.CSSProperties => ({
  borderRadius: 8, border: `1px solid ${BORDER}`, background: "#fff", padding: "9px 16px",
  fontSize: 12, fontWeight: 600, color: BRAND, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
});

function Kpi({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: string }) {
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${BORDER}`, background: "#fff", padding: 14, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" }}>
      <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", letterSpacing: 1.2, color: "#6b7280" }}>{label}</div>
      <div style={{ marginTop: 6, fontFamily: "ui-monospace, monospace", fontSize: 22, fontWeight: 700, color: accent ?? "#111827" }}>{value}</div>
      {sub && <div style={{ marginTop: 4, fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "2px 0", fontSize: 11.5 }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", color: "#1f2937", textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function LinkChip({ state, idle }: { state: LinkState; idle: boolean }) {
  const s = idle && state === "active"
    ? { t: "KEY EXPIRED · RE-KEYS ON SEND", b: "#fed7aa", bg: "#fff7ed", c: "#c2410c" }
    : {
      active: { t: "🔒 SECURE LINK · AES-256-GCM", b: "#bbf7d0", bg: "#f0fdf4", c: "#15803d" },
      connecting: { t: "ESTABLISHING SECURE LINK…", b: "#fed7aa", bg: "#fff7ed", c: "#c2410c" },
      error: { t: "LINK DOWN · CAPTURES HELD", b: "#fecaca", bg: "#fef2f2", c: "#b91c1c" },
      unavailable: { t: "NO SECURE CONTEXT", b: "#fecaca", bg: "#fef2f2", c: "#b91c1c" },
    }[state];
  return (
    <span style={{ borderRadius: 999, border: `1px solid ${s.b}`, background: s.bg, padding: "4px 10px", fontSize: 10, fontFamily: "ui-monospace, monospace", fontWeight: 700, color: s.c, whiteSpace: "nowrap" }}>
      {s.t}
    </span>
  );
}

function TxChip({ block }: { block: SurveyBlock }) {
  const map = {
    DETECTED: { t: "DETECTED", b: BORDER, bg: PANEL, c: "#6b7280" },
    SCANNING: { t: "SCANNING", b: "#fed7aa", bg: "#fff7ed", c: "#c2410c" },
    SENDING: { t: "SENDING", b: "#fde68a", bg: "#fffbeb", c: "#b45309" },
    TRANSMITTED: { t: block.transmission?.state === "duplicate" ? "ON FILE" : "DELIVERED", b: "#ddd6fe", bg: "#f5f3ff", c: BRAND },
    FAILED: { t: "HELD · RETRY", b: "#fecaca", bg: "#fef2f2", c: "#b91c1c" },
  }[block.status];
  return (
    <span style={{ borderRadius: 4, border: `1px solid ${map.b}`, background: map.bg, padding: "1px 6px", fontSize: 9, fontWeight: 700, color: map.c }}>{map.t}</span>
  );
}
