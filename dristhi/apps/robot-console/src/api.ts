import { getSession } from "./auth";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const s = getSession();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(s ? { Authorization: `Bearer ${s.token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Robot {
  robot_id: string;
  name: string;
  status: string;
  battery_percent: number;
  blocks_measured?: number;
  lat?: number;
  lon?: number;
  waypoint?: string;
  home_quarry?: string;
  last_seen?: string | null;
}

export interface Health {
  status: string;
  store: string;
  iot?: { mode: string; connected: boolean };
}

export interface Block {
  block_id: string;
  quarry_id: string;
  length_m: number;
  width_m: number;
  height_m: number;
  volume_m3: number;
  classification: string;
  status: string;
  source: string;
  // Optional GPS (present when the gateway returns it); the 3D scene falls
  // back to a deterministic scatter based on block_id when absent.
  lat?: number;
  lon?: number;
}

export interface Quarry {
  quarry_id: string;
  name: string;
  district: string;
  code?: string;
  lat: number;
  lon: number;
}

export const api = {
  health: () => req<Health>("/health"),
  listRobots: () => req<Robot[]>("/robots"),
  listBlocks: () => req<Block[]>("/blocks"),
  listQuarries: () => req<Quarry[]>("/quarries"),
  startSurvey: (id: string) => req<Robot>(`/robots/${id}/survey`, { method: "POST" }),
  stopSurvey: (id: string) => req<Robot>(`/robots/${id}/survey/stop`, { method: "POST" }),
};

// Real granite-bearing regions of Andhra Pradesh (offline demo mirror of the
// server registry). QUARRY = the home quarry the robots roam by default.
export const DEMO_QUARRIES: Quarry[] = [
  { quarry_id: "APQRY-0023", name: "Amaravati Granite Quarry", district: "Guntur", code: "AMR", lat: 16.5734, lon: 80.3567 },
  { quarry_id: "APQRY-0041", name: "Ongole Black Galaxy Unit", district: "Prakasam", code: "ONG", lat: 15.5057, lon: 80.0447 },
  { quarry_id: "APQRY-0058", name: "Chimakurthy Galaxy Belt", district: "Prakasam", code: "CHM", lat: 15.5793, lon: 79.8665 },
  { quarry_id: "APQRY-0072", name: "Srikakulam Blue Quarry", district: "Srikakulam", code: "SKL", lat: 18.2969, lon: 83.8974 },
  { quarry_id: "APQRY-0089", name: "Anantapur Grey Unit", district: "Anantapur", code: "ATP", lat: 14.6819, lon: 77.6006 },
  { quarry_id: "APQRY-0104", name: "Kurnool Pink Belt", district: "Kurnool", code: "KNL", lat: 15.8281, lon: 78.0373 },
];
export const QUARRY = { lat: DEMO_QUARRIES[0].lat, lon: DEMO_QUARRIES[0].lon };

export const DEMO_ROBOTS: Robot[] = [
  { robot_id: "DRISHTI-BOT-01", name: "Surveyor 1", status: "idle", battery_percent: 82, blocks_measured: 47, lat: QUARRY.lat, lon: QUARRY.lon, waypoint: "dock", home_quarry: "APQRY-0023" },
  { robot_id: "DRISHTI-BOT-02", name: "Surveyor 2", status: "charging", battery_percent: 45, blocks_measured: 12, lat: 15.5057, lon: 80.0447, waypoint: "charge-dock", home_quarry: "APQRY-0041" },
  { robot_id: "DRISHTI-BOT-03", name: "Surveyor 3", status: "idle", battery_percent: 90, blocks_measured: 5, lat: 18.2969, lon: 83.8974, waypoint: "dock", home_quarry: "APQRY-0072" },
];

// Offline demo blocks: rows across each quarry pit, GPS-tagged (home=12, rest=8).
const M_PER_DEG = 111_320;
function gpsOffset(baseLat: number, baseLon: number, eastM: number, northM: number) {
  return {
    lat: +(baseLat + northM / M_PER_DEG).toFixed(6),
    lon: +(baseLon + eastM / (M_PER_DEG * Math.cos((baseLat * Math.PI) / 180))).toFixed(6),
  };
}
const DEMO_DIMS: [number, number, number][] = [
  [2.34, 1.12, 0.87], [3.10, 1.55, 1.30], [1.90, 0.95, 0.70], [2.72, 1.28, 1.05],
  [3.45, 1.62, 1.42], [2.05, 1.05, 0.80], [2.90, 1.40, 1.15], [1.75, 0.90, 0.65],
  [3.25, 1.50, 1.35], [2.50, 1.20, 0.95], [3.60, 1.70, 1.50], [2.18, 1.08, 0.82],
];
const DEMO_STATUS = ["approved", "pending", "approved", "flagged", "pending", "approved",
  "pending", "approved", "flagged", "pending", "approved", "pending"];

export const DEMO_BLOCKS: Block[] = DEMO_QUARRIES.flatMap((q, qi) => {
  const n = qi === 0 ? 12 : 8;
  const cols = 4, gap = 28;
  return Array.from({ length: n }, (_, i) => {
    const [L, W, H] = DEMO_DIMS[i % DEMO_DIMS.length];
    const row = Math.floor(i / cols), col = i % cols;
    const { lat, lon } = gpsOffset(q.lat, q.lon, (col - (cols - 1) / 2) * gap, (row - 1) * gap - 10);
    const vol = +(L * W * H).toFixed(2);
    const classification = vol > 2.5 ? "above_gangsaw" : "below_gangsaw";
    return {
      block_id: `QRY-${q.code}-2026-${(100 + i).toString().padStart(4, "0")}`,
      quarry_id: q.quarry_id, length_m: L, width_m: W, height_m: H, volume_m3: vol,
      classification, status: DEMO_STATUS[i % DEMO_STATUS.length], source: "robot", lat, lon,
    } as Block;
  });
});
