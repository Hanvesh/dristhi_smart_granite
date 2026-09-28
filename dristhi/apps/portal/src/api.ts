import { getSession } from "./auth";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

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
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
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
}

export interface AuditEvent {
  block_id: string;
  event_type: string;
  actor: string;
  detail: Record<string, unknown>;
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
  analytics: () => req<{ total: number; approved: number; pending: number; revenue_inr: number; anomalies: number }>("/analytics/summary"),
  submitCapture: (payload: unknown) =>
    req<Block>("/captures", { method: "POST", body: JSON.stringify(payload) }),
};
