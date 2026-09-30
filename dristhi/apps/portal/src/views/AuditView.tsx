import React, { Fragment, useEffect, useMemo, useState } from "react";
import { Card, Badge } from "@drishti/ui";
import { api, AuditEvent } from "../api";
import { DEMO_AUDIT } from "../demoData";
import {
  BlockChange, DetailEntry, FieldChange, auditSearchText, blockChange, changeSummary, detailEntries, eventMeta,
} from "./auditFormat";
import { SearchBox, matchesQuery, mono, statusTone, td, th } from "./shared";

const muted = "var(--sos-text-muted)";

function fmt(ts: string) {
  try {
    return new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return ts;
  }
}

/** Compact vertical timeline for one block's lifecycle. */
export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <p style={{ color: muted }}>No audit events yet.</p>;
  return (
    <div style={{ display: "grid", gap: 0 }}>
      {events.map((e, i) => {
        const m = eventMeta(e.event_type);
        const last = i === events.length - 1;
        const c = blockChange(e);
        const change = changeSummary(c);
        const details = detailEntries(e, c).map((d) => `${d.label}: ${d.value}`).join(" · ");
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{
                width: 24, height: 24, borderRadius: "50%", background: m.color, color: "#fff",
                display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
              }}>{m.icon}</span>
              {!last && <span style={{ width: 2, flex: 1, background: "var(--sos-border)", minHeight: 18 }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 16 }}>
              <div style={{ fontWeight: 600, color: "var(--sos-text)" }}>{m.label}</div>
              <div style={{ fontSize: 12, color: muted }}>
                {fmt(e.created_at)} · by {e.actor}
              </div>
              {change && <div style={{ fontSize: 12, color: "var(--sos-text)", marginTop: 2 }}>{change}</div>}
              {details && <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{details}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const COLUMNS = ["When", "Block", "Event", "By", "Field", "Before", "After", "Details"];
// Keeps the layout steady when Before / After hold only short values or notes.
const COLUMN_MIN_WIDTH: Record<string, number> = { Before: 140, After: 140 };

interface Row {
  key: string;
  event: AuditEvent;
  change: BlockChange;
  details: DetailEntry[];
  text: string;
}

/** Department-wide audit feed (full page). */
export function AuditView() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [live, setLive] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");

  const load = async () => {
    try {
      setEvents(await api.auditFeed(200));
      setLive(true);
    } catch {
      setEvents(DEMO_AUDIT);
      setLive(false);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  // Describe each event once per fetch; both the table and the search use it.
  const rows = useMemo<Row[]>(() => {
    const seen = new Map<string, number>(); // events have no id: key on their content
    return events.map((event) => {
      const base = `${event.created_at}|${event.event_type}|${event.block_id}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const change = blockChange(event);
      const details = detailEntries(event, change);
      return { key: n > 1 ? `${base}#${n}` : base, event, change, details, text: auditSearchText(event, change, details) };
    });
  }, [events]);

  const searching = query.trim() !== "";
  const shown = searching ? rows.filter((r) => matchesQuery(r.text, query)) : rows;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Audit & Traceability</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {!live && <Badge tone="warning">offline demo data</Badge>}
          <SearchBox value={query} onChange={setQuery} label="Search audit events"
            placeholder="Search block ID, event, officer, value…" />
        </div>
      </div>
      <p style={{ margin: 0, color: muted, fontSize: 13 }}>
        Immutable, append-only record of every block's journey: measurement → seigniorage classification →
        OMEPS 2.0 cross-validation → officer approval/flag → dispatch. Field, Before and After show exactly what
        each event changed on the block.
      </p>
      <Card style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 12, color: muted }}>
          {/* Only the search result count is announced; the feed refreshes every few seconds. */}
          <span aria-live="polite">{searching ? `${shown.length} of ${events.length} events match “${query.trim()}”` : ""}</span>
          {!searching && loaded && <span>{events.length} most recent events, newest first</span>}
          {searching && <button type="button" onClick={() => setQuery("")} style={clearButton}>Clear search</button>}
        </div>
        {shown.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <caption style={srOnly}>
                Audit events, newest first. Field, Before and After list the block fields each event touched.
              </caption>
              <thead>
                <tr>{COLUMNS.map((h) => <th key={h} scope="col" style={{ ...th, minWidth: COLUMN_MIN_WIDTH[h] }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map((r) => <EventRows key={r.key} event={r.event} change={r.change} details={r.details} />)}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ margin: 0, color: muted, fontSize: 13 }}>
            {!loaded ? "Loading…" : searching ? `No audit events match “${query.trim()}”.` : "No audit events yet."}
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * One audit event: one table row per block field it touched (Field / Before /
 * After), with the event's own cells spanning them. An event that doesn't
 * touch a block is a single row of dashes.
 */
function EventRows({ event: e, change, details }: { event: AuditEvent; change: BlockChange; details: DetailEntry[] }) {
  const m = eventMeta(e.event_type);
  const lines = change.kind === "none" ? [] : change.fields;
  const span = Math.max(lines.length, 1);
  // One note stands in for every Before value when there is none to show.
  const beforeNote = change.kind === "created" ? "New block"
    : change.kind === "not_recorded" ? "Not recorded (older event)" : null;

  const lead = (
    <>
      <td rowSpan={span} style={td}><When ts={e.created_at} /></td>
      <td rowSpan={span} style={{ ...td, ...mono, whiteSpace: "nowrap" }}>{e.block_id}</td>
      <td rowSpan={span} style={td}>
        <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 8 }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, marginTop: 4, borderRadius: "50%", background: m.color, flex: "none" }} />
          {m.label}
        </span>
      </td>
      <td rowSpan={span} style={td}>{e.actor}</td>
    </>
  );
  const trail = <td rowSpan={span} style={{ ...td, minWidth: 200 }}><Details entries={details} /></td>;

  if (!lines.length) {
    const dash = <td style={{ ...td, color: muted }}>—</td>;
    return (
      <tr>
        {lead}
        {dash}{dash}{dash}
        {trail}
      </tr>
    );
  }
  return (
    <>
      {lines.map((f, j) => {
        const cell = subCell(j, lines.length);
        return (
          <tr key={f.label}>
            {j === 0 && lead}
            <td style={{ ...cell, color: muted, whiteSpace: "nowrap" }}>{f.label}</td>
            {beforeNote ? (
              j === 0 && <td rowSpan={span} style={{ ...td, color: muted }}>{beforeNote}</td>
            ) : (
              <td style={cell}><Value field={f} side="before" /></td>
            )}
            <td style={cell}><Value field={f} side="after" unchanged={change.kind === "unchanged"} /></td>
            {j === 0 && trail}
          </tr>
        );
      })}
    </>
  );
}

/** Date over time, so the column stays narrow. */
function When({ ts }: { ts: string }) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return <>{ts}</>;
  return (
    <time dateTime={ts} style={{ display: "block", whiteSpace: "nowrap" }}>
      {d.toLocaleDateString("en-IN", { dateStyle: "medium" })}
      <span style={{ display: "block", fontSize: 12, color: muted }}>
        {d.toLocaleTimeString("en-IN", { timeStyle: "medium" })}
      </span>
    </time>
  );
}

/** Field rows inside one event: tight spacing, a border only under the last. */
const subCell = (j: number, n: number): React.CSSProperties => ({
  ...td,
  padding: `${j === 0 ? 9 : 3}px 8px ${j === n - 1 ? 9 : 3}px`,
  borderBottom: j === n - 1 ? td.borderBottom : "none",
});

function Value({ field, side, unchanged }: { field: FieldChange; side: "before" | "after"; unchanged?: boolean }) {
  if (side === "after" && field.afterNote) return <span style={{ color: muted }}>{field.afterNote}</span>;
  const v = side === "before" ? field.before : field.after;
  if (v === null) return <span style={{ color: muted }}>—</span>;
  const emphasis = side === "after" && !unchanged;
  const value = field.key === "status"
    ? <Badge tone={statusTone(v)}>{v}</Badge>
    : <span style={{ ...mono, color: side === "before" ? muted : "var(--sos-text)", fontWeight: emphasis ? 600 : 400 }}>{v}</span>;
  if (side === "after" && unchanged) {
    return <>{value} <span style={{ color: muted, fontSize: 12, whiteSpace: "nowrap" }}>no change</span></>;
  }
  return value;
}

function Details({ entries }: { entries: DetailEntry[] }) {
  if (!entries.length) return <span style={{ color: muted }}>—</span>;
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8, rowGap: 2 }}>
      {entries.map((d, i) => (
        <Fragment key={`${d.label}-${i}`}>
          <dt style={{ color: muted, whiteSpace: "nowrap" }}>{d.label}</dt>
          <dd style={{ margin: 0, overflowWrap: "break-word" }}>{d.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const clearButton: React.CSSProperties = {
  background: "none", border: "none", padding: 0, color: "var(--sos-blue)", cursor: "pointer", fontSize: 12, fontWeight: 600,
};

const srOnly: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden",
  clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};
