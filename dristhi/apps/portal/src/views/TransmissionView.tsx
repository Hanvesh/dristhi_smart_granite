import React, { Fragment, useCallback, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Card, Badge } from "@drishti/ui";
import { api, LinkSession, Transmission } from "../api";
import { robotViewUrl } from "../robotLink";
import { Banner, JsonBlock, Kpi, errText, fmtTime, linkButton, mono, short, td, th, usePolling } from "./shared";

type Filter = "all" | Transmission["status"];

const statusTone = (s: Transmission["status"]) =>
  s === "accepted" ? "success" : s === "duplicate" ? "info" : "danger";
const sessionTone = (s: LinkSession["state"]) => (s === "active" ? "success" : s === "revoked" ? "danger" : "warning");

/** Robot -> Portal data transmission: every envelope the gateway received. */
export function TransmissionView({ canOpenRobot }: { canOpenRobot: boolean }) {
  const location = useLocation();
  const [tx, setTx] = useState<Transmission[]>([]);
  const [sessions, setSessions] = useState<LinkSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([api.transmissions(200), api.linkSessions()]);
      setTx(t);
      setSessions(s);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  usePolling(load, 3000);

  const count = (s: Transmission["status"]) => tx.filter((t) => t.status === s).length;
  const active = sessions.filter((s) => s.state === "active").length;
  const rows = filter === "all" ? tx : tx.filter((t) => t.status === filter);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0 }}>Data Transmission</h2>
          <p style={{ margin: "4px 0 0", color: "var(--sos-text-muted)", fontSize: 13 }}>
            Raw captures sent by robots over the secure robot link. Robots transmit sensor readings only; every
            calculation happens on the Portal side.
          </p>
        </div>
        {canOpenRobot && (
          <a href={robotViewUrl(location.pathname)} style={robotBtn}>Open Robot View ↗</a>
        )}
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      <Card style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>How the link is protected</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13, color: "var(--sos-text-muted)" }}>
          <li><b>Key agreement:</b> ephemeral ECDH P-256 per session → HKDF-SHA256 → 256-bit key. The key never crosses the network and is never stored.</li>
          <li><b>Envelope:</b> JWE compact (RFC 7516), <code>dir</code> + <code>A256GCM</code>, fresh 96-bit IV per message, protected header authenticated as AAD.</li>
          <li><b>Replay &amp; freshness:</b> single-use message id (jti) and sequence number inside a 64-message anti-replay window (tolerates MQTT reordering), ±5 min timestamp window.</li>
          <li><b>Key lifecycle:</b> sessions expire after 15 min or 10,000 messages, can be revoked, and only a robot-operator can open one.</li>
          <li><b>Payload:</b> strict raw-capture schema; any derived or business field (volume, class, fee…) is refused.</li>
        </ul>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Kpi label="RECEIVED" value={tx.length} />
        <Kpi label="ACCEPTED" value={count("accepted")} color="var(--sos-success)" />
        <Kpi label="DUPLICATES" value={count("duplicate")} color="var(--sos-section-blue)" />
        <Kpi label="REJECTED" value={count("rejected")} color="var(--sos-danger)" />
        <Kpi label="ACTIVE KEYS" value={active} />
      </div>

      <Card style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Robot link sessions</h3>
        {sessions.length === 0 ? (
          <p style={{ margin: 0, color: "var(--sos-text-muted)", fontSize: 13 }}>{loaded ? "No sessions yet. A robot opens one when it starts transmitting." : "Loading…"}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Device", "Key id", "Opened by", "Opened", "Expires", "Messages", "Last seq", "State"].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.kid}>
                    <td style={td}>{s.device_id}</td>
                    <td style={{ ...td, ...mono }} title={s.kid}>{short(s.kid, 12)}</td>
                    <td style={td}>{s.principal}</td>
                    <td style={td}>{fmtTime(s.created_at)}</td>
                    <td style={td}>{fmtTime(s.expires_at)}</td>
                    <td style={{ ...td, ...mono }}>{s.messages}/{s.max_messages}</td>
                    <td style={{ ...td, ...mono }}>{s.last_seq}</td>
                    <td style={td}><Badge tone={sessionTone(s.state)}>{s.state}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Transmission log</h3>
          <label style={{ fontSize: 13, color: "var(--sos-text-muted)" }}>
            Show{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--sos-border)" }}>
              <option value="all">all</option>
              <option value="accepted">accepted</option>
              <option value="duplicate">duplicate</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
        </div>
        {rows.length === 0 ? (
          <p style={{ margin: 0, color: "var(--sos-text-muted)", fontSize: 13 }}>
            {loaded ? "Nothing received yet. Open the Robot View and start a survey." : "Loading…"}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Received", "Device", "Type", "Seq", "Message id", "Size", "Clock skew", "Status", "Result"].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <Fragment key={t.id}>
                    <tr>
                      <td style={td}>
                        <button style={linkButton} aria-expanded={openId === t.id} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                          {openId === t.id ? "▾" : "▸"} {fmtTime(t.received_at)}
                        </button>
                      </td>
                      <td style={td}>{t.device_id ?? "—"}{!t.authenticated && t.device_id ? <span style={{ color: "var(--sos-text-muted)" }}> (claimed)</span> : null}</td>
                      <td style={td}>{t.content_type ?? "—"}</td>
                      <td style={{ ...td, ...mono }}>{t.seq ?? "—"}</td>
                      <td style={{ ...td, ...mono }} title={t.msg_id ?? ""}>{short(t.msg_id, 8)}</td>
                      <td style={{ ...td, ...mono }}>{t.size_bytes != null ? `${t.size_bytes} B` : "—"}</td>
                      <td style={{ ...td, ...mono }}>{t.clock_skew_s != null ? `${t.clock_skew_s.toFixed(1)} s` : "—"}</td>
                      <td style={td}><Badge tone={statusTone(t.status)}>{t.status}</Badge></td>
                      <td style={td}>
                        {t.status === "rejected" ? <span style={{ color: "var(--sos-danger)" }}>{t.reason}</span>
                          : t.capture_id ? <Link to={`/calculations?calc=${encodeURIComponent(t.capture_id)}`}>{t.block_id ?? "calculation"} →</Link>
                            : t.content_type === "telemetry" ? "robot state updated" : "—"}
                      </td>
                    </tr>
                    {openId === t.id && (
                      <tr>
                        <td colSpan={9} style={{ ...td, background: "var(--sos-light)" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                                JWE protected header {t.authenticated ? "(authenticated as AAD)" : "(claimed; not authenticated)"}
                              </div>
                              <JsonBlock value={t.header ?? {}} />
                              <div style={{ ...mono, marginTop: 6, color: "var(--sos-text-muted)" }}>
                                transport {t.transport ?? "—"} · payload SHA-256 {t.payload_sha256 ?? "—"}
                              </div>
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Decrypted raw payload</div>
                              {t.payload ? <JsonBlock value={t.payload} />
                                : <p style={{ margin: 0, fontSize: 13, color: "var(--sos-text-muted)" }}>
                                  {t.status === "rejected" ? "Not stored: the envelope was rejected." : "Not a new capture."}
                                </p>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

const robotBtn: React.CSSProperties = {
  background: "var(--sos-blue)", color: "#fff", borderRadius: "var(--sos-radius-sm)", padding: "8px 16px",
  fontWeight: 600, fontSize: 14, textDecoration: "none",
};
