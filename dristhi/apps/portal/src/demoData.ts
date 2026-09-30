import type { AuditEvent, Block, BlockSnapshot } from "./api";

// Offline fallback blocks. Enriched with the same MT basis / rate / category
// fields the live backend pipeline produces, so the Portal renders identical
// numbers online and offline (kept in sync with services/seigniorage/rules.py).
export const DEMO_BLOCKS: Block[] = [
  {
    block_id: "QRY-AMR-2026-0100",
    quarry_id: "APQRY-0023",
    length_m: 2.34,
    width_m: 1.12,
    height_m: 0.87,
    volume_m3: 2.28,
    confidence: 0.94,
    classification: "below_gangsaw",
    seigniorage_fee_inr: 4560,
    rate_per_m3_inr: 2000,
    tonnage_mt: 6.84,
    category_name: "Black Galaxy (Below Gangsaw)",
    granite_category: "black_galaxy",
    source: "robot",
    status: "approved",
    measurement_method: "robot_stereo_pointcloud",
  },
  {
    block_id: "QRY-AMR-2026-0101",
    quarry_id: "APQRY-0023",
    length_m: 3.1,
    width_m: 1.55,
    height_m: 1.3,
    volume_m3: 6.25,
    confidence: 0.88,
    classification: "above_gangsaw",
    seigniorage_fee_inr: 12500,
    rate_per_m3_inr: 2000,
    tonnage_mt: 18.75,
    category_name: "Black Galaxy (Above Gangsaw)",
    granite_category: "black_galaxy",
    source: "robot",
    status: "pending",
    measurement_method: "robot_stereo_pointcloud",
  },
  {
    block_id: "QRY-ONG-2026-0100",
    quarry_id: "APQRY-0041",
    length_m: 1.9,
    width_m: 0.95,
    height_m: 0.7,
    volume_m3: 1.26,
    confidence: 0.72,
    classification: "below_gangsaw",
    seigniorage_fee_inr: 2520,
    rate_per_m3_inr: 2000,
    tonnage_mt: 3.78,
    category_name: "Black Galaxy (Below Gangsaw)",
    granite_category: "black_galaxy",
    source: "mobile",
    status: "flagged",
    measurement_method: "mobile_monocular",
  },
];

// Offline audit trail for the demo blocks above, newest first. Same
// before/after shape the gateway records (services/gateway/audit_changes.py).
const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const measuredFields = (b: Block): BlockSnapshot => ({
  length_m: b.length_m, width_m: b.width_m, height_m: b.height_m, volume_m3: b.volume_m3,
  confidence: b.confidence, measurement_method: b.measurement_method, status: "pending",
});
const assessedFields = (b: Block): BlockSnapshot => ({
  classification: b.classification, category_name: b.category_name, rate_per_m3_inr: b.rate_per_m3_inr,
  seigniorage_fee_inr: b.seigniorage_fee_inr, tonnage_mt: b.tonnage_mt,
});
const [approvedBlock, , flaggedBlock] = DEMO_BLOCKS;
const pending: BlockSnapshot = { status: "pending" };

export const DEMO_AUDIT: AuditEvent[] = [
  {
    block_id: approvedBlock.block_id, event_type: "approved", actor: "officer", created_at: minsAgo(3),
    detail: { e_transit_pass_no: "ETP-AP-4821", before: pending, after: { status: "approved" } },
  },
  {
    block_id: approvedBlock.block_id, event_type: "omeps_synced", actor: "officer", created_at: minsAgo(4),
    detail: { anomaly: false, message: "Synced to OMEPS 2.0", before: pending, after: pending },
  },
  {
    block_id: approvedBlock.block_id, event_type: "classified", actor: "seigniorage-engine", created_at: minsAgo(5),
    detail: { class: approvedBlock.classification, fee_inr: approvedBlock.seigniorage_fee_inr, before: null, after: assessedFields(approvedBlock) },
  },
  {
    block_id: approvedBlock.block_id, event_type: "measured", actor: "DRISHTI-BOT-01", created_at: minsAgo(6),
    detail: { method: approvedBlock.measurement_method, confidence: approvedBlock.confidence, before: null, after: measuredFields(approvedBlock) },
  },
  {
    block_id: flaggedBlock.block_id, event_type: "omeps_synced", actor: "officer", created_at: minsAgo(20),
    detail: {
      anomaly: true, weighbridge_volume_m3: 2.37, divergence: 0.468,
      message: "Anomaly: AI vs weighbridge divergence exceeds tolerance",
      before: pending, after: { status: "flagged" },
    },
  },
  {
    block_id: flaggedBlock.block_id, event_type: "classified", actor: "seigniorage-engine", created_at: minsAgo(24),
    detail: { class: flaggedBlock.classification, before: null, after: assessedFields(flaggedBlock) },
  },
  {
    block_id: flaggedBlock.block_id, event_type: "measured", actor: "mobile", created_at: minsAgo(25),
    detail: { method: flaggedBlock.measurement_method, via: "field-capture", before: null, after: measuredFields(flaggedBlock) },
  },
];
