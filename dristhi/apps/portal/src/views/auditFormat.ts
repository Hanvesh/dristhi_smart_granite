// How audit events are described in the Portal: labels, the block fields an
// event changed (before -> after) and its other recorded facts. Shared by the
// Audit Trail table and the per-block lifecycle timeline on the Blocks page.
import { classificationLabel, inrExact } from "@drishti/ui";
import type { AuditEvent, BlockSnapshot } from "../api";
import { fmtTime } from "./shared";

// ── Event types ──────────────────────────────────────────────────────────────
const EVENT_META: Record<string, { label: string; color: string; icon: string }> = {
  measured: { label: "Measured", color: "var(--sos-blue)", icon: "M" },
  classified: { label: "Classified", color: "#7b61ff", icon: "C" },
  omeps_synced: { label: "OMEPS cross-validated", color: "#0a9396", icon: "O" },
  approved: { label: "Approved", color: "var(--sos-success)", icon: "A" },
  flagged: { label: "Flagged (anomaly)", color: "var(--sos-danger)", icon: "!" },
  rejected: { label: "Rejected", color: "var(--sos-danger)", icon: "R" },
  transmitted: { label: "Transmitted (secure robot link)", color: "#5b3fd1", icon: "T" },
  calculation_warning: { label: "Calculation warning", color: "#B26A00", icon: "W" },
  survey_started: { label: "Survey started", color: "var(--sos-blue)", icon: "S" },
  survey_stopped: { label: "Survey stopped", color: "var(--sos-text-muted)", icon: "S" },
};

export function eventMeta(type: string) {
  return EVENT_META[type] ?? { label: type, color: "var(--sos-text-muted)", icon: "•" };
}

/** Event types that change a block. The gateway records before / after for these. */
const BLOCK_CHANGING = new Set(["measured", "classified", "omeps_synced", "approved", "rejected", "flagged"]);

// ── Formatting ───────────────────────────────────────────────────────────────
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown) => (v == null || v === "" ? null : String(v));
const pct = (v: number) => `${+(v * 100).toFixed(1)}%`;
const classText = (v: unknown) =>
  v === "above_gangsaw" || v === "below_gangsaw" ? classificationLabel(v) : text(v);

interface FieldDef {
  label: string;
  keys: (keyof BlockSnapshot)[];
  /** Display value, or null when the block had no value. */
  format: (s: BlockSnapshot) => string | null;
}

// Non-breaking spaces keep numbers and their units together in narrow table cells.
const NB = "\u00a0";

/** Block fields shown in Field / Before / After, in display order. */
const FIELDS: FieldDef[] = [
  {
    label: `L${NB}×${NB}W${NB}×${NB}H`, keys: ["length_m", "width_m", "height_m"],
    format: (s) => (isNum(s.length_m) && isNum(s.width_m) && isNum(s.height_m)
      ? [s.length_m, s.width_m, s.height_m].join(`${NB}×${NB}`) + `${NB}m` : null),
  },
  { label: "Volume", keys: ["volume_m3"], format: (s) => (isNum(s.volume_m3) ? `${s.volume_m3}${NB}m³` : null) },
  { label: "Confidence", keys: ["confidence"], format: (s) => (isNum(s.confidence) ? pct(s.confidence) : null) },
  { label: "Method", keys: ["measurement_method"], format: (s) => text(s.measurement_method) },
  { label: "Class", keys: ["classification"], format: (s) => classText(s.classification) },
  { label: "Category", keys: ["category_name"], format: (s) => text(s.category_name) },
  { label: "Rate", keys: ["rate_per_m3_inr"], format: (s) => (isNum(s.rate_per_m3_inr) ? `${inrExact(s.rate_per_m3_inr)}/m³` : null) },
  { label: "Fee", keys: ["seigniorage_fee_inr"], format: (s) => (isNum(s.seigniorage_fee_inr) ? inrExact(s.seigniorage_fee_inr) : null) },
  { label: "Tonnage", keys: ["tonnage_mt"], format: (s) => (isNum(s.tonnage_mt) ? `${s.tonnage_mt}${NB}MT` : null) },
  { label: "Status", keys: ["status"], format: (s) => text(s.status) },
];

// ── Before / after ───────────────────────────────────────────────────────────
export interface FieldChange {
  /** First block field behind this row ("status" renders as a badge). */
  key: keyof BlockSnapshot;
  label: string;
  before: string | null;
  after: string | null;
  changed: boolean;
  /** Shown in After instead of a value, e.g. "No change". */
  afterNote?: string;
}

export type BlockChange =
  | { kind: "none" } // the event doesn't change a block (transmission, warnings, robot surveys)
  | { kind: "not_recorded"; fields: FieldChange[] } // older event: Before unknown, After = what the event proves
  | { kind: "created"; fields: FieldChange[] } // the event created the block: After values only
  | { kind: "changed"; fields: FieldChange[] } // only the fields that changed
  | { kind: "unchanged"; fields: FieldChange[] }; // every field the event tracks, unchanged

const isSnapshot = (v: unknown): v is BlockSnapshot => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

function toRows(before: BlockSnapshot | null, after: BlockSnapshot): FieldChange[] {
  return FIELDS.filter((f) => f.keys.some((k) => k in after)).map((f) => ({
    key: f.keys[0],
    label: f.label,
    before: before ? f.format(before) : null,
    after: f.format(after),
    changed: !before || f.keys.some((k) => !same(before[k], after[k])),
  }));
}

/**
 * Events logged before the gateway recorded snapshots still prove some
 * after-values through their type and facts: an "approved" event means the
 * status became approved, and every capture saves the block as pending.
 */
function provenFields(e: AuditEvent): FieldChange[] {
  const d: AuditEvent["detail"] = e.detail ?? {};
  const known: BlockSnapshot = {};
  switch (e.event_type) {
    case "approved":
    case "rejected":
    case "flagged":
      known.status = e.event_type;
      break;
    case "omeps_synced":
      if (d.anomaly === true) known.status = "flagged"; // an anomaly flags the block
      break;
    case "measured":
      known.measurement_method = text(d.method);
      if (isNum(d.confidence)) known.confidence = d.confidence;
      known.status = "pending";
      break;
    case "classified":
      known.classification = text(d.class);
      if (isNum(d.fee_inr)) known.seigniorage_fee_inr = d.fee_inr;
      break;
  }
  const rows = toRows(null, known).filter((r) => r.after !== null);
  // A clean OMEPS check never changes the block.
  return rows.length ? rows : [{ key: "status", label: "Status", before: null, after: null, changed: false, afterNote: "No change" }];
}

/** What an audit event did to its block. */
export function blockChange(e: AuditEvent): BlockChange {
  const d: AuditEvent["detail"] = e.detail ?? {};
  const after = d.after;
  if (!isSnapshot(after)) {
    return BLOCK_CHANGING.has(e.event_type) ? { kind: "not_recorded", fields: provenFields(e) } : { kind: "none" };
  }
  const before = isSnapshot(d.before) ? d.before : null;
  const rows = toRows(before, after);
  if (!before) return { kind: "created", fields: rows.filter((r) => r.after !== null) };
  const changed = rows.filter((r) => r.changed);
  return changed.length ? { kind: "changed", fields: changed } : { kind: "unchanged", fields: rows };
}

/** One-line version of a block change, for compact views such as the lifecycle timeline. */
export function changeSummary(c: BlockChange): string | null {
  switch (c.kind) {
    case "created":
      return c.fields.length ? `New block · ${c.fields.map((f) => `${f.label}: ${f.after}`).join(" · ")}` : "New block";
    case "changed":
      return c.fields.map((f) => `${f.label}: ${f.before ?? "—"} → ${f.after ?? "—"}`).join(" · ");
    case "not_recorded": {
      const proven = c.fields.filter((f) => f.after !== null);
      return proven.length ? proven.map((f) => `${f.label}: ${f.after}`).join(" · ") : "No change to the block";
    }
    case "unchanged":
      return "No change to the block";
    default:
      return null;
  }
}

// ── Other recorded facts ─────────────────────────────────────────────────────
export interface DetailEntry {
  label: string;
  value: string;
}

const yesNo = (v: unknown) => (v === true ? "yes" : v === false ? "no" : String(v));
const money = (v: unknown) => (isNum(v) ? inrExact(v) : String(v));
const percent = (v: unknown) => (isNum(v) ? pct(v) : String(v));

const DETAIL_KEYS: Record<string, { label: string; format?: (v: unknown) => string }> = {
  message: { label: "Result" },
  weighbridge_volume_m3: { label: "Weighbridge", format: (v) => `${v}${NB}m³` },
  divergence: { label: "Divergence", format: percent },
  anomaly: { label: "Anomaly", format: yesNo },
  synced: { label: "Synced", format: yesNo },
  note: { label: "Note" },
  reason: { label: "Reason" },
  e_transit_pass_no: { label: "E-transit pass" },
  method: { label: "Method" },
  via: { label: "Via" },
  confidence: { label: "Confidence", format: percent },
  class: { label: "Class", format: (v) => classText(v) ?? "—" },
  fee_inr: { label: "Fee", format: money },
  total_payable_inr: { label: "Total payable", format: money },
  capture_id: { label: "Capture" },
  msg_id: { label: "Message id" },
  channel: { label: "Channel" },
  warnings: { label: "Warnings" },
  blocks: { label: "Blocks" },
  quarry: { label: "Quarry" },
};

/** Detail keys that repeat a block field, hidden when After already shows that field. */
const SHOWN_AS_FIELD: Record<string, keyof BlockSnapshot> = {
  method: "measurement_method", confidence: "confidence", class: "classification", fee_inr: "seigniorage_fee_inr",
};

const humanize = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The event's recorded facts other than before / after, labelled for display. */
export function detailEntries(e: AuditEvent, change: BlockChange = blockChange(e)): DetailEntry[] {
  const d: AuditEvent["detail"] = e.detail ?? {};
  const inAfter = new Set(change.kind === "none" ? [] : change.fields.filter((f) => f.after !== null).map((f) => f.key));
  const hasMessage = typeof d.message === "string" && d.message !== "";
  const out: DetailEntry[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === "before" || k === "after" || k === "block_id" || v == null || v === "") continue;
    if ((k === "anomaly" || k === "synced") && hasMessage) continue; // the OMEPS message already says it
    const field = SHOWN_AS_FIELD[k];
    if (field && inAfter.has(field)) continue;
    const def = DETAIL_KEYS[k];
    const value = def?.format ? def.format(v) : typeof v === "object" ? JSON.stringify(v) : String(v);
    out.push({ label: def?.label ?? humanize(k), value });
  }
  return out;
}

// ── Search ───────────────────────────────────────────────────────────────────
const KIND_WORDS: Record<BlockChange["kind"], string> = {
  none: "", not_recorded: "not recorded", created: "new block", changed: "changed", unchanged: "no change",
};

/** Everything someone might search the audit trail for, as one string. */
export function auditSearchText(e: AuditEvent, change: BlockChange, details: DetailEntry[]): string {
  const fields = change.kind === "none" ? []
    : change.fields.flatMap((f) => [f.label, f.before ?? "", f.after ?? "", f.afterNote ?? ""]);
  return [
    e.block_id, e.event_type, eventMeta(e.event_type).label, e.actor, fmtTime(e.created_at), KIND_WORDS[change.kind],
    ...details.flatMap((d) => [d.label, d.value]), ...fields,
  ].join(" ");
}
