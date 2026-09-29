// Robot-side secure link (drishti-robot-link/v1), WebCrypto implementation.
// Same protocol as robot/drishti_link.py; verified by the gateway's
// services/gateway/secure_link.py.
//
//  1. Key agreement: ephemeral ECDH P-256 key pair (private key is
//     non-extractable), POST /robot-link/sessions with the operator's bearer
//     token, then HKDF-SHA256 over the shared secret -> non-extractable
//     AES-256-GCM key. The key itself is never sent or stored.
//  2. Every message is a JWE compact envelope (RFC 7516), alg "dir",
//     enc "A256GCM", fresh random 96-bit IV, protected header as AAD. The
//     header carries kid, device, a strictly increasing seq, a single-use jti
//     and iat, so the gateway can reject tampering, replays and stale sends.
//  3. Re-keys automatically near expiry / message budget and once on 401.
//
// WebCrypto only exists in secure contexts (HTTPS or localhost). There is no
// plaintext fallback: if it is unavailable, nothing is transmitted.

const PROTOCOL = "drishti-robot-link/v1";
const TYP = "drishti-robot-msg+jwe";
const REKEY_MARGIN_MS = 60_000;
const REKEY_AT_FRACTION = 0.9;

const enc = new TextEncoder();

export type ContentType = "capture" | "telemetry";

export interface LinkInfo {
  protocol: string;
  kid: string;
  deviceId: string;
  alg: "dir";
  enc: "A256GCM";
  kdf: string;
  openedAt: number;
  expiresAt: number;
  maxMessages: number;
  messages: number;
  lastSeq: number;
}

export interface Receipt {
  status: "accepted" | "duplicate";
  receipt_id: string;
  capture_id: string | null;
  seq: number;
  kid: string;
  received_at: string;
}

export interface TransmitResult {
  receipt: Receipt;
  header: Record<string, unknown>;
  bytes: number;
}

export class LinkError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export function secureContextAvailable(): boolean {
  const secure = typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : true;
  return secure && !!globalThis.crypto?.subtle;
}

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Return types are inferred on purpose: TS >= 5.7 infers Uint8Array<ArrayBuffer>,
// which WebCrypto's BufferSource parameters require.
function b64uDecode(text: string) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

interface Session {
  key: CryptoKey;
  info: LinkInfo;
  clockOffsetMs: number;
}

export class SecureLink {
  private session: Session | null = null;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private opts: {
    base: string;
    deviceId: string;
    getToken: () => string | null;
    onChange?: (info: LinkInfo | null) => void;
  }) {}

  info(): LinkInfo | null {
    return this.session ? { ...this.session.info } : null;
  }

  /** Open a fresh session (ECDH P-256 + HKDF-SHA256). */
  async connect(): Promise<LinkInfo> {
    if (!secureContextAvailable()) {
      throw new LinkError("WebCrypto is unavailable: open the Robot View over HTTPS or localhost");
    }
    const token = this.opts.getToken();
    if (!token) throw new LinkError("Not signed in", 401);

    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const res = await fetch(`${this.opts.base}/robot-link/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_id: this.opts.deviceId, epk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }),
    });
    const offer = await res.json().catch(() => ({}));
    if (!res.ok) throw new LinkError(`Session refused (${res.status}): ${offer.detail ?? "gateway error"}`, res.status);
    if (offer.protocol !== PROTOCOL || offer.alg !== "dir" || offer.enc !== "A256GCM" || offer.typ !== TYP) {
      throw new LinkError("Gateway offered an unexpected protocol profile");
    }

    const serverPub = await crypto.subtle.importKey(
      "jwk", { kty: "EC", crv: "P-256", x: offer.server_epk.x, y: offer.server_epk.y, ext: true },
      { name: "ECDH", namedCurve: "P-256" }, true, [],
    );
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, pair.privateKey, 256);
    const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const robotRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const serverRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverPub));
    const zero = new Uint8Array([0]);
    const info = concat(enc.encode(PROTOCOL), zero, enc.encode(offer.kid), zero,
      enc.encode(this.opts.deviceId), zero, robotRaw, zero, serverRaw);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: b64uDecode(offer.salt), info },
      hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
    );

    const now = Date.now();
    this.seq = 0;
    this.session = {
      key,
      clockOffsetMs: typeof offer.server_time === "number" ? offer.server_time * 1000 - now : 0,
      info: {
        protocol: offer.protocol, kid: offer.kid, deviceId: this.opts.deviceId, alg: "dir", enc: "A256GCM",
        kdf: offer.kdf ?? "ECDH-P256+HKDF-SHA256", openedAt: now, expiresAt: now + offer.expires_in * 1000,
        maxMessages: offer.max_messages, messages: 0, lastSeq: 0,
      },
    };
    this.opts.onChange?.(this.info());
    return this.session.info;
  }

  private needsRekey(): boolean {
    const s = this.session;
    if (!s) return true;
    if (Date.now() >= s.info.expiresAt - REKEY_MARGIN_MS) return true;
    return s.info.messages >= Math.floor(s.info.maxMessages * REKEY_AT_FRACTION);
  }

  private async seal(cty: ContentType, payload: unknown): Promise<{ token: string; header: Record<string, unknown> }> {
    if (this.needsRekey()) await this.connect();
    const s = this.session!;
    this.seq += 1;
    s.info.messages += 1;
    s.info.lastSeq = this.seq;
    const header = {
      alg: "dir", enc: "A256GCM", typ: TYP, cty, kid: s.info.kid, dev: this.opts.deviceId,
      seq: this.seq, jti: crypto.randomUUID(), iat: Math.floor((Date.now() + s.clockOffsetMs) / 1000),
    };
    const h = b64u(enc.encode(JSON.stringify(header)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(h), tagLength: 128 },
      s.key, enc.encode(JSON.stringify(payload)),
    ));
    const ciphertext = sealed.slice(0, sealed.length - 16);
    const tag = sealed.slice(sealed.length - 16); // WebCrypto appends the tag
    return { token: `${h}..${b64u(iv)}.${b64u(ciphertext)}.${b64u(tag)}`, header };
  }

  private async post(token: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.opts.base}/robot-link/ingest`, {
      method: "POST", headers: { "Content-Type": "application/jose" }, body: token,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Encrypt + send one payload. Serialised so seq order == arrival order. */
  transmit(cty: ContentType, payload: unknown): Promise<TransmitResult> {
    const run = async (): Promise<TransmitResult> => {
      let { token, header } = await this.seal(cty, payload);
      let { status, body } = await this.post(token);
      if (status === 401) { // session expired/revoked on the gateway: re-key once
        this.session = null;
        ({ token, header } = await this.seal(cty, payload));
        ({ status, body } = await this.post(token));
      }
      this.opts.onChange?.(this.info());
      if (status !== 200 && status !== 202) {
        throw new LinkError(`Transmission rejected (${status}): ${body.detail ?? "gateway error"}`, status);
      }
      return { receipt: body as Receipt, header, bytes: token.length };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Revoke the session key on the gateway (sign-out). Best effort. */
  async close(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.opts.onChange?.(null);
    const token = this.opts.getToken();
    if (!s || !token) return;
    try {
      await fetch(`${this.opts.base}/robot-link/sessions/${encodeURIComponent(s.info.kid)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* gateway unreachable: the key still expires on its own */ }
  }
}
