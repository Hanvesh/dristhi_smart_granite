// Shared quarry registry + GPS boundary helpers used by BOTH UIs (Portal +
// Robot Console). Each quarry has a real AP granite-belt centre and a
// rectangular geofence boundary (half-extents in metres) so captured GPS can be
// validated against the pit and random in-boundary points can be generated.
//
// The Robot View deploys against this registry, and the gateway mirrors it in
// services/gateway/quarry_registry.py (granite category + concession geofence
// used by the portal-side calculation pipeline). Keep the three in sync.

export type GraniteType = "black_galaxy" | "colour" | "grey";

export interface Quarry {
  code: string;
  name: string;
  district: string;
  type: GraniteType;
  centerLat: number;
  centerLon: number;
  // Half-extents of the rectangular concession boundary, in metres.
  halfWidthM: number;  // east-west
  halfHeightM: number; // north-south
}

// Metres per degree latitude (approx, constant). Longitude scales by cos(lat).
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export const QUARRIES: Quarry[] = [
  { code: "APQRY-0023", name: "Chimakurthy Black Galaxy Quarry", district: "Prakasam", type: "black_galaxy", centerLat: 15.5810, centerLon: 79.8620, halfWidthM: 320, halfHeightM: 260 },
  { code: "APQRY-0117", name: "Ongole Galaxy Extraction Pit", district: "Prakasam", type: "black_galaxy", centerLat: 15.5057, centerLon: 80.0447, halfWidthM: 280, halfHeightM: 300 },
  { code: "APQRY-0245", name: "Srikakulam Blue Granite Field", district: "Srikakulam", type: "colour", centerLat: 18.2969, centerLon: 83.8974, halfWidthM: 360, halfHeightM: 240 },
  { code: "APQRY-0388", name: "Chittoor Grey Granite Bench", district: "Chittoor", type: "grey", centerLat: 13.2172, centerLon: 79.1003, halfWidthM: 300, halfHeightM: 300 },
  { code: "APQRY-0451", name: "Anantapur Colour Granite Pit", district: "Anantapur", type: "colour", centerLat: 14.6819, centerLon: 77.6006, halfWidthM: 340, halfHeightM: 220 },
  { code: "APQRY-0512", name: "Guntur Pearl Galaxy Bench", district: "Guntur", type: "black_galaxy", centerLat: 16.3067, centerLon: 80.4365, halfWidthM: 300, halfHeightM: 280 },
  { code: "APQRY-0574", name: "Kurnool Multi-Colour Pit", district: "Kurnool", type: "colour", centerLat: 15.8281, centerLon: 78.0373, halfWidthM: 320, halfHeightM: 260 },
  { code: "APQRY-0619", name: "Kadapa Green Marble Quarry", district: "Kadapa", type: "colour", centerLat: 14.4673, centerLon: 78.8242, halfWidthM: 300, halfHeightM: 260 },
  { code: "APQRY-0688", name: "Nellore Grey Granite Field", district: "Nellore", type: "grey", centerLat: 14.4426, centerLon: 79.9865, halfWidthM: 300, halfHeightM: 300 },
  { code: "APQRY-0742", name: "Vizianagaram Silver Grey Bench", district: "Vizianagaram", type: "grey", centerLat: 18.1066, centerLon: 83.3956, halfWidthM: 300, halfHeightM: 280 },
];

export const quarryByCode = (code: string): Quarry | undefined => QUARRIES.find((q) => q.code === code);

/** Convert a metre offset (east, north) from a quarry centre to a lat/lon. */
export function offsetToLatLon(q: Quarry, eastM: number, northM: number): { lat: number; lon: number } {
  const lat = q.centerLat + northM / M_PER_DEG_LAT;
  const lon = q.centerLon + eastM / mPerDegLon(q.centerLat);
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

/** The rectangular boundary corners of a quarry (for display). */
export function quarryBounds(q: Quarry): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
  const dLat = q.halfHeightM / M_PER_DEG_LAT;
  const dLon = q.halfWidthM / mPerDegLon(q.centerLat);
  return {
    minLat: +(q.centerLat - dLat).toFixed(6), maxLat: +(q.centerLat + dLat).toFixed(6),
    minLon: +(q.centerLon - dLon).toFixed(6), maxLon: +(q.centerLon + dLon).toFixed(6),
  };
}

/** True if a GPS point lies within the quarry's rectangular concession. */
export function pointInQuarry(lat: number, lon: number, q: Quarry): boolean {
  const b = quarryBounds(q);
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

/** Distance in metres from a point to the quarry centre (for "how far outside"). */
export function distanceToCenterM(lat: number, lon: number, q: Quarry): number {
  const dy = (lat - q.centerLat) * M_PER_DEG_LAT;
  const dx = (lon - q.centerLon) * mPerDegLon(q.centerLat);
  return Math.round(Math.hypot(dx, dy));
}

/** A random GPS point guaranteed to lie inside the quarry boundary. */
export function randomPointInQuarry(q: Quarry): { lat: number; lon: number } {
  const eastM = (Math.random() * 2 - 1) * q.halfWidthM;
  const northM = (Math.random() * 2 - 1) * q.halfHeightM;
  return offsetToLatLon(q, eastM, northM);
}
