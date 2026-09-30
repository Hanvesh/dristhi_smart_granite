import { getSession } from "./auth";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

/** HTTP error from the gateway (as opposed to the gateway being unreachable). */
export class ApiError extends Error {
  constructor(public status: number, public detail: string, path: string) {
    super(`API ${path} failed: ${status}${detail ? ` (${detail})` : ""}`);
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const session = getSession();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = typeof body?.detail === "string" ? body.detail : "";
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, detail, path);
  }
  return res.json() as Promise<T>;
}

export interface Block {
  block_id: string;
  quarry_id: string;
  length_m: number;
  width_m: number;
  height_m: number;
  volume_m3: number;
  confidence: number;
  classification: string;
  seigniorage_fee_inr: number;
  source: string;
  status: string;
  measurement_method: string;
  // Enriched seigniorage / MT basis (shared backend pipeline). Optional so the
  // UI degrades gracefully against an older gateway.
  rate_per_m3_inr?: number;
  tonnage_mt?: number;
  category_name?: string;
  granite_category?: string;
}

/** Block fields as an audit event recorded them. Only the fields that event is responsible for are present. */
export type BlockSnapshot = { [K in keyof Block]?: Block[K] | null };

export interface AuditEvent {
  block_id: string;
  event_type: string;
  actor: string;
  /**
   * Event facts. Events that change a block (measured, classified,
   * omeps_synced, approved, rejected, flagged) also carry `before` and
   * `after`: the fields they touched, just before and just after the event.
   * `before` is null when the event created the block. Events recorded
   * before the gateway started capturing this have neither key.
   */
  detail: Record<string, unknown> & { before?: BlockSnapshot | null; after?: BlockSnapshot | null };
  created_at: string;
}

export const api = {
  listBlocks: () => req<Block[]>("/blocks"),
  getBlock: (id: string) => req<Block>(`/blocks/${id}`),
  approve: (id: string) => req<Block>(`/blocks/${id}/approve`, { method: "POST" }),
  flag: (id: string) => req<Block>(`/blocks/${id}/flag`, { method: "POST" }),
  omepsSync: (id: string, weight?: number) =>
    req<{ anomaly: boolean; divergence: number | null; weighbridge_volume_m3: number | null; message: string }>(
      `/omeps/sync/${id}${weight != null ? `?weighbridge_weight_mt=${weight}` : ""}`,
      { method: "POST" },
    ),
  blockAudit: (id: string) => req<AuditEvent[]>(`/blocks/${id}/audit`),
  auditFeed: (limit = 100) => req<AuditEvent[]>(`/audit?limit=${limit}`),
  analytics: () => req<{ total: number; approved: number; pending: number; revenue_inr: number; anomalies: number; total_volume_m3?: number; total_tonnage_mt?: number; above_gangsaw?: number; below_gangsaw?: number }>("/analytics/summary"),
  submitCapture: (payload: unknown) =>
    req<Block>("/captures", { method: "POST", body: JSON.stringify(payload) }),
  estimateField: (payload: FieldEstimateRequest) =>
    req<FieldEstimate>("/field/estimate", { method: "POST", body: JSON.stringify(payload) }),

  // Robot -> portal data transmission (secure robot link)
  linkSessions: () => req<LinkSession[]>("/robot-link/sessions"),
  transmissions: (limit = 100) => req<Transmission[]>(`/transmissions?limit=${limit}`),
  // Portal-side calculations
  calculations: (limit = 100) => req<Calculation[]>(`/calculations?limit=${limit}`),
  calculation: (id: string) => req<Calculation>(`/calculations/${encodeURIComponent(id)}`),
  retryCalculation: (id: string) =>
    req<{ calc_id: string; status: string }>(`/calculations/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  // Approvals
  approvalQueue: () => req<ApprovalQueueItem[]>("/approvals/queue"),
  approvals: (limit = 100) => req<ApprovalRecord[]>(`/approvals?limit=${limit}`),
  decide: (blockId: string, decision: "approve" | "reject", note?: string) =>
    req<ApprovalRecord & { block: Block }>(`/approvals/${encodeURIComponent(blockId)}`, {
      method: "POST", body: JSON.stringify({ decision, note: note || null }),
    }),
};

export interface LinkSession {
  kid: string;
  device_id: string;
  principal: string;
  created_at: string;
  expires_at: string;
  messages: number;
  max_messages: number;
  last_seq: number;
  last_message_at: string | null;
  state: "active" | "expired" | "revoked" | "exhausted";
  alg: string;
  enc: string;
  kdf: string;
}

export interface Transmission {
  id: number;
  msg_id: string | null;
  device_id: string | null;
  kid: string | null;
  seq: number | null;
  content_type: string | null;
  status: "accepted" | "duplicate" | "rejected";
  reason: string | null;
  size_bytes: number | null;
  clock_skew_s: number | null;
  payload_sha256: string | null;
  header: Record<string, unknown> | null;
  capture_id: string | null;
  transport: string | null;
  authenticated: boolean;
  received_at: string;
  block_id: string | null;
  payload: Record<string, unknown> | null;
}

export interface CalcStep {
  step: string;
  title: string;
  engine?: string;
  formula?: string;
  values: Record<string, unknown> | null;
}

export interface CalcWarning {
  code: string;
  message: string;
}

export interface CalcOutputs {
  block_id: string;
  length_m: number;
  width_m: number;
  height_m: number;
  volume_m3: number;
  confidence: number;
  classification: string;
  granite_category: string;
  category_name: string;
  rate_per_m3_inr: number;
  seigniorage_fee_inr: number;
  dmf_inr: number | null;
  nmet_inr: number | null;
  total_payable_inr: number | null;
  tonnage_mt: number;
}

export interface Calculation {
  calc_id: string;
  block_id: string | null;
  capture_id: string | null;
  device_id: string | null;
  quarry_id: string | null;
  source: string;
  status: "running" | "completed" | "failed";
  steps: CalcStep[];
  outputs: Partial<CalcOutputs>;
  warnings: CalcWarning[];
  error: string | null;
  engine: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface ApprovalQueueItem {
  block: Block;
  calculation: Calculation | null;
  omeps: { anomaly?: boolean; divergence?: number | null; weighbridge_volume_m3?: number | null; message?: string } | null;
}

export interface ApprovalRecord {
  id: number;
  block_id: string;
  decision: "approved" | "rejected";
  actor: string;
  role: string | null;
  note: string | null;
  e_transit_pass_no: string | null;
  total_payable_inr: number | null;
  created_at: string;
}

export interface FieldEstimateRequest {
  granite_type: string;
  marker_real_mm: number;
  marker_pixels: number;
  block_length_px: number;
  block_width_px: number;
  block_height_px: number;
  perspective_correction?: number;
  fill_factor?: number;
  block_id?: string;
  quarry_id?: string;
  lat?: number;
  lon?: number;
}

export interface FieldEstimate {
  method: string;
  metres_per_pixel: number;
  length_m: number;
  width_m: number;
  height_m: number;
  volume_m3: number;
  confidence: number;
  classification: string;
  granite_category: string;
  category_name: string;
  rate_per_m3_inr: number;
  tonnage_mt: number;
  seigniorage_fee_inr: number;
  threshold_m3: number;
  persisted: boolean;
  block?: Block;
}
