// Shared formatting + seigniorage helpers used by BOTH UIs (Portal + Robot
// Console) so they render identical numbers. Mirrors the reference demo's
// frontend-next/lib/format.js. Single source of truth = the two dashboards stay
// in sync.

/** Rupees, no decimals (e.g. ₹8,351). */
export const inr = (n: number | null | undefined): string =>
  "\u20B9" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

/** Rupees, exact two decimals (e.g. ₹8,351.28). */
export const inrExact = (n: number | null | undefined): string =>
  "\u20B9" +
  Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface SeigniorageBreakdown {
  base: number;
  dmf: number;
  nmet: number;
  total: number;
}

/**
 * Andhra Pradesh seigniorage split used across the Form-M style panels:
 * base royalty + District Mineral Foundation (DMF 10%) + National Mineral
 * Exploration Trust (NMET 2%). Illustrative demo rates, matching the reference
 * demo. `baseFeeInr` is the block's seigniorage_fee_inr from the backend.
 */
export function seigniorageBreakdown(baseFeeInr: number | null | undefined): SeigniorageBreakdown {
  const base = Number(baseFeeInr || 0);
  const dmf = base * 0.1;
  const nmet = base * 0.02;
  return { base, dmf, nmet, total: base + dmf + nmet };
}

/** Human-readable granite category label from the raw category key. */
export const graniteLabel = (t: string | null | undefined): string => {
  switch (t) {
    case "black_galaxy":
      return "Black Galaxy";
    case "srikakulam_blue":
      return "Srikakulam Blue";
    case "colour":
      return "Colour Granite";
    case "grey":
    case "generic":
      return "Grey/Common Granite";
    default:
      return t || "—";
  }
};

/** "above_gangsaw" -> "Above Gangsaw"; "below_gangsaw" -> "Below Gangsaw". */
export const classificationLabel = (c: string | null | undefined): string =>
  c === "above_gangsaw" ? "Above Gangsaw" : c === "below_gangsaw" ? "Below Gangsaw" : "—";


// ── OMEPS 2.0 cross-validation ───────────────────────────────────────────────
// Mirrors services/omeps-adapter/main.py EXACTLY so the Portal's offline result
// matches the backend byte-for-byte. Granite density ~2.7 MT/m3 derives a
// weighbridge volume from weight; a divergence beyond 15% flags an anomaly.
export const OMEPS_DENSITY_MT_PER_M3 = 2.7;
export const OMEPS_ANOMALY_TOLERANCE = 0.15;

export interface OmepsResult {
  weighbridge_volume_m3: number | null;
  divergence: number | null;
  anomaly: boolean;
  message: string;
}

export function omepsCrossCheck(
  aiVolumeM3: number,
  weighbridgeWeightMt: number | null | undefined,
): OmepsResult {
  let wbVolume: number | null = null;
  let divergence: number | null = null;
  let anomaly = false;
  if (weighbridgeWeightMt != null) {
    wbVolume = round2(weighbridgeWeightMt / OMEPS_DENSITY_MT_PER_M3);
    if (wbVolume > 0) {
      divergence = round3(Math.abs(aiVolumeM3 - wbVolume) / wbVolume);
      anomaly = divergence > OMEPS_ANOMALY_TOLERANCE;
    }
  }
  return {
    weighbridge_volume_m3: wbVolume,
    divergence,
    anomaly,
    message: anomaly
      ? "Anomaly: AI vs weighbridge divergence exceeds tolerance"
      : "Synced to OMEPS 2.0 (mock)",
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
