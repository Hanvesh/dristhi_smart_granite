// Cross-app capture channel. When a block is captured in the Officer Portal it
// is appended here (localStorage), and the Robot Console (or any other tab)
// picks it up via the `storage` event + an initial read. This keeps both UIs
// consistent WITHOUT requiring the gateway to be running — a captured block
// shows up in the robot UI's block ledger.

export interface CapturedBlock {
  blockId: string;
  quarryCode: string;
  quarryName: string;
  district: string;
  graniteType: string;
  lengthM: number;
  widthM: number;
  heightM: number;
  volumeM3: number;
  classification: string; // above_gangsaw | below_gangsaw
  categoryName?: string;
  ratePerM3Inr?: number;
  tonnageMt?: number;
  seigniorageFeeInr: number;
  lat: number | null;
  lon: number | null;
  insideBoundary: boolean;
  source: "field-capture";
  capturedAt: string; // ISO
}

const KEY = "drishti.captures";
const MAX = 200;

function read(): CapturedBlock[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CapturedBlock[]) : [];
  } catch {
    return [];
  }
}

export const captureBus = {
  /** All captured blocks (newest first). */
  list(): CapturedBlock[] {
    return read();
  },

  /** Append a captured block and notify listeners (this tab + others). */
  publish(block: CapturedBlock) {
    const next = [block, ...read().filter((b) => b.blockId !== block.blockId)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    // The `storage` event only fires in OTHER tabs, so dispatch a same-tab
    // custom event too for listeners in the publishing app.
    try {
      window.dispatchEvent(new CustomEvent("drishti:capture", { detail: block }));
    } catch {
      /* non-browser env */
    }
  },

  /**
   * Subscribe to captures. Fires `cb` with the full list on any change (from
   * this tab or another). Returns an unsubscribe function.
   */
  subscribe(cb: (blocks: CapturedBlock[]) => void): () => void {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) cb(read());
    };
    const onCustom = () => cb(read());
    window.addEventListener("storage", onStorage);
    window.addEventListener("drishti:capture", onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("drishti:capture", onCustom as EventListener);
    };
  },

  clear() {
    localStorage.removeItem(KEY);
  },
};
