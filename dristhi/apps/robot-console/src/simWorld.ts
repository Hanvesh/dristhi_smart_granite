// Simulated quarry world + on-board sensors for the Robot View.
//
// This models what the rover physically encounters and what its sensors
// report. It deliberately contains NO business rules: no gangsaw threshold,
// no volume formula, no rates, density, tonnage, fees, reconciliation or
// approvals. The robot captures raw readings and transmits them; everything
// derived from them is computed portal-side (gateway pipeline -> vision ->
// seigniorage). The gateway also refuses payloads that carry derived values.

import { QUARRIES, Quarry, offsetToLatLon } from "@drishti/ui";
import type { SceneBlockStatus } from "./quarryScene";

export const DEVICE_ID = "DRISHTI-BOT-01";
export const FIRMWARE = "drishti-rover-sim/2.0";
export const LIDAR_SENSOR = "sim-lidar-360";
const LIDAR_POINTS_PER_SEC = 48_200;

/** Pits the rover can be deployed to (shared registry, same as the Portal). */
export const DEPLOY_SITES: Quarry[] = QUARRIES;

/** Wire format, mirrors services/gateway/robot_schema.py (RawCapture). */
export interface RawCapture {
  schema: "drishti.robot.capture/v1";
  capture_id: string;
  quarry_id: string;
  block_ref: string;
  captured_at: string;
  sensor: {
    lidar: { extent_x_m: number; extent_y_m: number; extent_z_m: number; point_count: number; scan_ms: number; sensor: string };
    camera: { frame_ref: string; frame_sha256: string; width_px: number; height_px: number };
    gnss: { lat: number; lon: number; accuracy_m: number; fix: "RTK_FIXED" };
  };
  robot: { battery_percent: number; status: "surveying"; firmware: string };
}

export interface Transmission {
  state: "sending" | "accepted" | "duplicate" | "failed";
  receiptId?: string;
  seq?: number;
  kid?: string;
  msgId?: string;
  bytes?: number;
  at: string;
  error?: string;
}

export interface SurveyBlock {
  blockId: string;          // robot-local detection reference (block_ref)
  status: SceneBlockStatus;
  sceneX: number;           // metres east of the pit centre
  sceneZ: number;           // metres south of the pit centre (scene +z)
  // Ground truth of the simulated world. The sensor sees it with noise; only
  // the noisy readings ever leave the robot.
  trueL: number;
  trueW: number;
  trueH: number;
  dimensions: { lengthM: number; widthM: number; heightM: number } | null;
  capture?: RawCapture;
  envelopeHeader?: Record<string, unknown>;
  transmission?: Transmission;
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const round = (v: number, p: number) => { const f = Math.pow(10, p); return Math.round(v * f) / f; };
const hash = (str: string) => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/** Deterministic block layout per pit (the physical world the rover finds). */
export function buildBlocks(site: Quarry): SurveyBlock[] {
  const rng = makeRng(hash(site.code));
  const count = 10 + Math.floor(rng() * 6);
  const cols = Math.ceil(Math.sqrt(count));
  const cell = 6, half = ((cols - 1) * cell) / 2;
  const blocks: SurveyBlock[] = [];
  for (let i = 0; i < count; i++) {
    const trueL = round(1.4 + rng() * 2.0, 2);
    const trueW = round(0.8 + rng() * 1.2, 2);
    const trueH = round(0.5 + rng() * 1.3, 2);
    let x: number, z: number;
    if (rng() < 0.28) {
      const a = rng() * Math.PI * 2, r = half + 12 + rng() * 20;
      x = round(Math.cos(a) * r, 2); z = round(Math.sin(a) * r, 2);
    } else {
      const col = i % cols, row = Math.floor(i / cols);
      x = round(col * cell - half + (rng() - 0.5) * cell * 0.6, 2);
      z = round(row * cell - half + (rng() - 0.5) * cell * 0.6, 2);
    }
    blocks.push({
      blockId: `${site.code.replace("APQRY-", "QRY-")}-${800 + i}`,
      status: "DETECTED", trueL, trueW, trueH, sceneX: x, sceneZ: z, dimensions: null,
    });
  }
  return blocks;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One LiDAR + RGB + GNSS capture of a block: raw sensor readings only.
 * Extents carry +/-2 cm sensor noise; the GNSS fix is RTK-grade.
 */
export async function captureBlock(block: SurveyBlock, site: Quarry, batteryPercent: number): Promise<RawCapture> {
  const noise = (amp: number) => (Math.random() - 0.5) * 2 * amp;
  const captureId = crypto.randomUUID();
  const capturedAt = new Date().toISOString();
  const scanMs = Math.round(1600 + Math.random() * 600);
  const pos = offsetToLatLon(site, block.sceneX + noise(0.02), -block.sceneZ + noise(0.02));
  const frameRef = `frames/${site.code}/${block.blockId}/${captureId}.jpg`;
  return {
    schema: "drishti.robot.capture/v1",
    capture_id: captureId,
    quarry_id: site.code,
    block_ref: block.blockId,
    captured_at: capturedAt,
    sensor: {
      lidar: {
        extent_x_m: round(Math.max(0.05, block.trueL + noise(0.02)), 3),
        extent_y_m: round(Math.max(0.05, block.trueW + noise(0.02)), 3),
        extent_z_m: round(Math.max(0.05, block.trueH + noise(0.02)), 3),
        point_count: Math.round(LIDAR_POINTS_PER_SEC * (scanMs / 1000) * (0.9 + Math.random() * 0.2)),
        scan_ms: scanMs,
        sensor: LIDAR_SENSOR,
      },
      // Simulated evidence frame: the hash stands in for the JPEG's digest.
      camera: { frame_ref: frameRef, frame_sha256: await sha256Hex(`${frameRef}|${capturedAt}`), width_px: 1920, height_px: 1080 },
      gnss: { lat: pos.lat, lon: pos.lon, accuracy_m: round(0.02 + Math.random() * 0.03, 3), fix: "RTK_FIXED" },
    },
    robot: { battery_percent: Math.round(batteryPercent), status: "surveying", firmware: FIRMWARE },
  };
}
