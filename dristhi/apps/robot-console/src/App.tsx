import React, { useEffect, useState } from "react";
import { BrandLogo, TopNav, Card, Button, Badge, Table } from "@drishti/ui";
import { getSession, logout, Session } from "./auth";
import { Login } from "./Login";
import { api, Robot, Block, Health, Quarry, DEMO_ROBOTS, DEMO_BLOCKS, DEMO_QUARRIES } from "./api";
import { Quarry3D } from "./Quarry3D";

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const [robots, setRobots] = useState<Robot[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [quarries, setQuarries] = useState<Quarry[]>(DEMO_QUARRIES);
  const [health, setHealth] = useState<Health | null>(null);
  const [live, setLive] = useState(true);

  // Poll robot telemetry frequently (smooth roaming) and blocks less often.
  const loadRobots = async () => {
    try {
      const r = await api.listRobots();
      setRobots(r); setLive(true);
    } catch {
      setRobots((prev) => (prev.length ? prev : DEMO_ROBOTS)); setLive(false);
    }
  };
  const loadBlocks = async () => {
    try { setBlocks(await api.listBlocks()); }
    catch { setBlocks((prev) => (prev.length ? prev : DEMO_BLOCKS)); }
  };
  const loadHealth = async () => {
    try { setHealth(await api.health()); } catch { /* keep last */ }
  };

  useEffect(() => {
    if (!session) return;
    loadRobots(); loadBlocks(); loadHealth();
    api.listQuarries().then((q) => q.length && setQuarries(q)).catch(() => {});
    const rt = setInterval(loadRobots, 700);  // fast: roaming telemetry
    const bt = setInterval(loadBlocks, 2500);  // slower: block set
    const ht = setInterval(loadHealth, 5000);
    return () => { clearInterval(rt); clearInterval(bt); clearInterval(ht); };
  }, [session]);

  if (!session) return <Login onLogin={() => setSession(getSession())} />;

  const signOut = () => { logout(); setSession(null); };

  const toggle = async (r: Robot) => {
    const busy = r.status === "surveying" || r.status === "returning" || r.status === "charging";
    try {
      if (busy) await api.stopSurvey(r.robot_id); else await api.startSurvey(r.robot_id);
      await loadRobots();
    } catch {
      setRobots((rs) => rs.map((x) => x.robot_id === r.robot_id
        ? { ...x, status: busy ? "idle" : "surveying" } : x));
    }
  };

  return (
    <div>
      <TopNav
        title={<><BrandLogo /><span style={{ fontWeight: 700 }}>Robot Operations Console</span></>}
        right={<>
          <IotBadge health={health} live={live} />
          <Badge tone="info">robot-operator</Badge>
          <span style={{ color: "var(--sos-text-muted)" }}>{session.username}</span>
          <Button variant="ghost" onClick={signOut}>Sign out</Button>
        </>}
      />
      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto", display: "grid", gap: 16 }}>
        <QuarryScene robots={robots} blocks={blocks} quarries={quarries} />
        <FleetView robots={robots} live={live} onToggle={toggle} />
        <LiveFeed robots={robots} blocks={blocks} quarries={quarries} />
      </main>
    </div>
  );
}

function IotBadge({ health, live }: { health: Health | null; live: boolean }) {
  if (!live) return <Badge tone="warning">offline demo</Badge>;
  const mode = health?.iot?.mode ?? "off";
  if (mode === "aws") return <Badge tone="success">AWS IoT connected</Badge>;
  return <Badge tone="info">telemetry: HTTP</Badge>;
}

function statusTone(s: string): "success" | "danger" | "warning" | "info" {
  if (s === "surveying" || s === "returning") return "success";
  if (s === "offline") return "danger";
  if (s === "charging") return "info";
  return "warning";
}

// ── Live 3D quarry: terrain + granite blocks (sized by measurement) + robot ──
function QuarryScene({ robots, blocks, quarries }: { robots: Robot[]; blocks: Block[]; quarries: Quarry[] }) {
  const active = robots.find((r) => r.status === "surveying" || r.status === "returning" || r.status === "charging");
  const [follow, setFollow] = useState(true);
  // Which quarry the 3D scene is centered on. Defaults to the active robot's home.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-focus the quarry of the active robot when a survey is running.
  useEffect(() => {
    if (follow && active?.home_quarry) setSelectedId(active.home_quarry);
  }, [follow, active?.home_quarry]);

  const quarryId = selectedId ?? active?.home_quarry ?? quarries[0]?.quarry_id;
  const quarry = quarries.find((q) => q.quarry_id === quarryId) ?? quarries[0];
  const center = quarry ? { lat: quarry.lat, lon: quarry.lon } : undefined;

  // Only show blocks/robots belonging to the viewed quarry.
  const sceneBlocks = blocks.filter((b) => b.quarry_id === quarryId);
  const sceneRobots = robots.filter((r) => r.home_quarry === quarryId || !r.home_quarry);
  const followId = follow ? (sceneRobots.find((r) =>
    r.status === "surveying" || r.status === "returning" || r.status === "charging")?.robot_id ?? null) : null;

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px 8px", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Quarry Survey — live 3D</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <select
            value={quarryId ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--sos-border)", fontSize: 13, background: "var(--sos-surface)" }}
          >
            {quarries.map((q) => (
              <option key={q.quarry_id} value={q.quarry_id}>{q.name} · {q.district}</option>
            ))}
          </select>
          <div style={{ display: "flex", border: "1px solid var(--sos-border)", borderRadius: 8, overflow: "hidden" }}>
            <ToggleBtn active={follow} onClick={() => setFollow(true)}>Follow robot</ToggleBtn>
            <ToggleBtn active={!follow} onClick={() => setFollow(false)}>Free orbit</ToggleBtn>
          </div>
        </div>
      </div>
      <Quarry3D robots={sceneRobots} blocks={sceneBlocks} followRobotId={followId} center={center} />
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", padding: "10px 20px 16px", color: "var(--sos-text-muted)", fontSize: 12 }}>
        <Legend swatch="#39d98a" label="robot roaming" />
        <Legend swatch="#f5a623" label="dock / charging" />
        <Legend swatch="#3f4652" label="above gangsaw block" />
        <Legend swatch="#5a6273" label="below gangsaw block" />
        <Legend swatch="#ff4d4f" label="flagged (OMEPS anomaly)" />
        <span>
          {follow && followId
            ? <>Following the rover across <b>{quarry?.name}</b> — {sceneBlocks.length} blocks. Position streams over AWS IoT.</>
            : <>Viewing <b>{quarry?.name}</b>, {quarry?.district} — {sceneBlocks.length} blocks. Drag to orbit, scroll to zoom.</>}
        </span>
      </div>
    </Card>
  );
}

function ToggleBtn({ active, disabled, onClick, children }: {
  active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: "none", padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: disabled ? "default" : "pointer",
        background: active ? "var(--sos-blue)" : "transparent",
        color: active ? "#fff" : disabled ? "var(--sos-text-muted)" : "var(--sos-blue)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 12, height: 12, borderRadius: 3, background: swatch, display: "inline-block" }} />
      {label}
    </span>
  );
}

function FleetView({ robots, live, onToggle }: { robots: Robot[]; live: boolean; onToggle: (r: Robot) => void }) {
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Fleet Overview</h2>
        {!live && <Badge tone="warning">offline demo data</Badge>}
      </div>
      <Table
        columns={["Robot", "Status", "Battery", "Waypoint", "Blocks", "Survey control"]}
        rows={robots.map((r) => [
          <b>{r.name}</b>,
          <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
          <BatteryBar pct={r.battery_percent} />,
          <span style={{ color: "var(--sos-text-muted)" }}>{r.waypoint ?? "—"}</span>,
          r.blocks_measured ?? "—",
          (() => {
            const busy = r.status === "surveying" || r.status === "returning" || r.status === "charging";
            return (
              <Button variant={busy ? "danger" : "success"} onClick={() => onToggle(r)}>
                {busy ? "Stop survey" : "Start survey"}
              </Button>
            );
          })(),
        ])}
      />
    </Card>
  );
}

function BatteryBar({ pct }: { pct: number }) {
  const color = pct > 50 ? "var(--sos-success)" : pct > 20 ? "var(--sos-warning)" : "var(--sos-danger)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 60, height: 8, background: "var(--sos-border)", borderRadius: 4, overflow: "hidden" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: color }} />
      </span>
      {pct}%
    </span>
  );
}

function LiveFeed({ robots, blocks, quarries }: { robots: Robot[]; blocks: Block[]; quarries: Quarry[] }) {
  const active = robots.find((r) => r.status === "surveying" || r.status === "returning" || r.status === "charging");
  // Stats + chase-cam scope to the active robot's quarry (or all blocks if idle).
  const scopeId = active?.home_quarry;
  const scoped = scopeId ? blocks.filter((b) => b.quarry_id === scopeId) : blocks;
  const q = quarries.find((x) => x.quarry_id === scopeId);
  const center = q ? { lat: q.lat, lon: q.lon } : undefined;
  const sceneRobots = scopeId ? robots.filter((r) => r.home_quarry === scopeId) : robots;
  const measured = scoped.length;
  const flagged = scoped.filter((b) => b.status === "flagged").length;
  const totalVolume = scoped.reduce((a, b) => a + (b.volume_m3 || 0), 0);
  const lastBlock = scoped[scoped.length - 1];

  return (
    <Card>
      <h2 style={{ marginTop: 0 }}>Live Survey Feed</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        {/* Robot's-eye view: a real 3D view that follows the active rover. */}
        <div style={{ border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius)", overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", background: "var(--sos-light)", fontWeight: 600, display: "flex", justifyContent: "space-between" }}>
            <span>Robot camera — chase view</span>
            <span style={{ color: "var(--sos-text-muted)", fontWeight: 400 }}>
              {active ? active.name : "no active survey"}
            </span>
          </div>
          <Quarry3D robots={sceneRobots} blocks={scoped} height={200}
            followRobotId={active?.robot_id ?? null} center={center} />
        </div>
        {/* Live telemetry + survey stats from real data. */}
        <div style={{ border: "1px solid var(--sos-border)", borderRadius: "var(--sos-radius)", padding: 16, display: "grid", gap: 10, alignContent: "start" }}>
          <Stat label="Survey status" value={active ? `surveying (${active.name})` : "idle"} tone={active ? "success" : "muted"} />
          <Stat label="Current waypoint" value={active?.waypoint ?? "—"} />
          <Stat label="Battery" value={active ? `${active.battery_percent}%` : "—"} />
          <Stat label="Blocks in quarry" value={`${measured}`} />
          <Stat label="Total measured volume" value={`${totalVolume.toFixed(1)} m³`} />
          <Stat label="Flagged (OMEPS anomaly)" value={`${flagged}`} tone={flagged ? "danger" : "muted"} />
          {lastBlock && (
            <Stat label="Last block" value={`${lastBlock.block_id.replace("QRY-", "")} · ${lastBlock.volume_m3} m³ · ${lastBlock.classification.replace("_", " ")}`} />
          )}
        </div>
      </div>
      <p style={{ color: "var(--sos-text-muted)", marginTop: 12 }}>
        {active
          ? <>The chase view follows <b>{active.name}</b> as it roams. Each block it reaches is measured (stereo point cloud → L×W×H → volume), classified, priced, and streamed over AWS IoT into the Officer Portal.</>
          : <>No survey running. Click <b>Start survey</b> on a robot above — it drives the rover autonomously (roams, streams telemetry, measures blocks); watch it live here and in the 3D scene.</>}
      </p>
    </Card>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" | "danger" | "muted" }) {
  const color = tone === "success" ? "var(--sos-success)" : tone === "danger" ? "var(--sos-danger)"
    : tone === "muted" ? "var(--sos-text-muted)" : "var(--sos-text)";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
      <span style={{ color: "var(--sos-text-muted)", fontSize: 12 }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontSize: 14, textAlign: "right" }}>{value}</span>
    </div>
  );
}
