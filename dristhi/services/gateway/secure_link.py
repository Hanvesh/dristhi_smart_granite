"""
Secure robot -> gateway link.

The robot transmits raw captures only. Every message is protected at the
application layer, on top of (not instead of) TLS / AWS IoT mutual TLS on the
transport, so a payload stays confidential and tamper-evident through proxies,
brokers, queues and logs until the gateway opens it here.

1. Session key agreement (per robot session, forward secret)
   POST /robot-link/sessions carries the robot's ephemeral ECDH P-256 public
   key (JWK). The gateway answers with its own ephemeral public key and a
   random salt. Both sides compute the ECDH shared secret and derive a 256-bit
   AES key with HKDF-SHA256 (RFC 5869); the HKDF info binds the protocol
   label, key id, device id and both public keys. The key itself never goes
   over the wire and the gateway does not keep its ephemeral private key.

2. Message protection: JWE compact serialization (RFC 7516), alg "dir",
   enc "A256GCM" (RFC 7518 section 5.3):
       BASE64URL(header) . "" . BASE64URL(iv) . BASE64URL(ciphertext) . BASE64URL(tag)
   A fresh random 96-bit IV per message; the encoded protected header is the
   AAD, so routing metadata (kid, dev, seq, jti, iat) is authenticated even
   though it is not encrypted. No compression ("zip") is accepted.

3. Replay and freshness
   - iat must be within +/- max_skew_s of gateway time
   - jti (message id) is single-use per session
   - seq is single-use and must fall inside a sliding anti-replay window
     (default 64) below the highest seq seen, as in IPsec ESP (RFC 4303).
     A window rather than "strictly increasing" because AWS IoT Core does not
     guarantee MQTT message order (QoS 1 retries reorder messages).
   Replay state is committed only after the AES-GCM tag verifies, so a forged
   header can never poison it.

4. Key lifecycle
   Sessions expire after ttl_s and are capped at max_messages (far below the
   2^32 random-IV limit per key from NIST SP 800-38D); the robot then re-keys.
   Sessions can be revoked. Keys live only in gateway process memory.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional, Union

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PROTOCOL = "drishti-robot-link/v1"
JWE_TYP = "drishti-robot-msg+jwe"
CONTENT_TYPES = ("capture", "telemetry")
KDF_LABEL = "ECDH-P256+HKDF-SHA256"

SESSION_TTL_S = int(os.getenv("DRISHTI_LINK_SESSION_TTL_S", "900"))
MAX_MESSAGES_PER_SESSION = int(os.getenv("DRISHTI_LINK_MAX_MESSAGES", "10000"))
MAX_CLOCK_SKEW_S = int(os.getenv("DRISHTI_LINK_MAX_SKEW_S", "300"))
REPLAY_WINDOW = int(os.getenv("DRISHTI_LINK_REPLAY_WINDOW", "64"))
MAX_SESSIONS_PER_DEVICE = 4
MAX_TRACKED_SESSIONS = 500
SESSION_RETENTION_S = 3600  # keep ended sessions visible (metadata only) this long
MAX_ENVELOPE_BYTES = 64 * 1024

DEVICE_ID_PATTERN = r"^[A-Z0-9][A-Z0-9-]{2,47}$"
_DEVICE_ID_RE = re.compile(DEVICE_ID_PATTERN[1:-1])
_JTI_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")
_KID_RE = re.compile(r"[A-Za-z0-9_-]{22}")
_B64U_RE = re.compile(r"[A-Za-z0-9_-]*")
_MAX_SEQ = 2**53 - 1  # JS Number.MAX_SAFE_INTEGER; the browser robot uses Numbers


class LinkError(Exception):
    """A handshake or envelope was rejected.

    `reason` is precise and goes to the transmission log (visible to portal
    officers). `public` is what the sender gets back; it is deliberately vague
    for crypto/replay failures so the endpoint is not an oracle.
    """

    def __init__(self, reason: str, status: int = 400, public: str = "message rejected"):
        super().__init__(reason)
        self.reason = reason
        self.status = status
        self.public = public


def b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: object) -> bytes:
    """Strict base64url (no padding, URL-safe alphabet only)."""
    if not isinstance(text, str) or not _B64U_RE.fullmatch(text) or len(text) % 4 == 1:
        raise ValueError("invalid base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def raw_point(pub: ec.EllipticCurvePublicKey) -> bytes:
    """65-byte uncompressed SEC1 point (0x04 || X || Y), same as WebCrypto 'raw'."""
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def public_jwk(pub: ec.EllipticCurvePublicKey) -> dict:
    raw = raw_point(pub)
    return {"kty": "EC", "crv": "P-256", "x": b64u_encode(raw[1:33]), "y": b64u_encode(raw[33:65])}


def load_public_jwk(jwk: object) -> ec.EllipticCurvePublicKey:
    """Parse a P-256 public JWK. from_encoded_point() rejects points that are
    not on the curve (invalid-curve attack protection)."""
    bad = "invalid ephemeral public key"
    if not isinstance(jwk, dict):
        raise LinkError("epk is not a JWK object", public=bad)
    if "d" in jwk:
        raise LinkError("epk contains private key material",
                        public="private key material must never be transmitted")
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise LinkError("epk is not an EC P-256 key", public="ephemeral key must be EC P-256")
    try:
        x = b64u_decode(jwk.get("x"))
        y = b64u_decode(jwk.get("y"))
    except ValueError:
        raise LinkError("epk coordinates are not base64url", public=bad) from None
    if len(x) != 32 or len(y) != 32:
        raise LinkError("epk coordinates have the wrong length", public=bad)
    try:
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b"\x04" + x + y)
    except ValueError:
        raise LinkError("epk point is not on P-256", public=bad) from None


def hkdf_info(kid: str, device_id: str, robot_point: bytes, server_point: bytes) -> bytes:
    """Context binding for HKDF. Must be byte-identical on robot and gateway."""
    return b"\x00".join([
        PROTOCOL.encode("ascii"), kid.encode("ascii"), device_id.encode("ascii"),
        robot_point, server_point,
    ])


def derive_session_key(shared_secret: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(shared_secret)


def peek_header(envelope: Union[bytes, str]) -> dict:
    """Best-effort, UNAUTHENTICATED view of an envelope's header, used only to
    label rejected messages in the transmission log. Never trust it."""
    try:
        text = envelope.decode("ascii") if isinstance(envelope, (bytes, bytearray)) else str(envelope)
        first = text.strip().split(".", 1)[0]
        if len(first) > 4096:
            return {}
        header = json.loads(b64u_decode(first))
    except Exception:
        return {}
    if not isinstance(header, dict):
        return {}
    out: dict = {}
    for k in ("alg", "enc", "typ", "cty", "kid", "dev", "jti"):
        v = header.get(k)
        if isinstance(v, str):
            out[k] = v[:64]
    for k in ("seq", "iat"):
        v = header.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = v
    return out


@dataclass
class LinkSession:
    kid: str
    device_id: str
    principal: str
    created_at: float
    expires_at: float
    max_messages: int
    aead: AESGCM = field(repr=False)
    messages: int = 0
    last_seq: int = 0
    last_message_at: Optional[float] = None
    revoked: bool = False
    seen_jti: set = field(default_factory=set, repr=False)
    seen_seq: set = field(default_factory=set, repr=False)  # only seqs inside the window

    def state(self, now: float) -> str:
        if self.revoked:
            return "revoked"
        if now >= self.expires_at:
            return "expired"
        if self.messages >= self.max_messages:
            return "exhausted"
        return "active"

    def public_view(self, now: float) -> dict:
        """Metadata only. Never includes key material."""
        return {
            "kid": self.kid, "device_id": self.device_id, "principal": self.principal,
            "created_at": _iso(self.created_at), "expires_at": _iso(self.expires_at),
            "messages": self.messages, "max_messages": self.max_messages,
            "last_seq": self.last_seq, "last_message_at": _iso(self.last_message_at),
            "state": self.state(now), "alg": "dir", "enc": "A256GCM", "kdf": KDF_LABEL,
        }


@dataclass
class OpenedMessage:
    header: dict
    payload: dict
    kid: str
    device_id: str
    principal: str
    content_type: str
    seq: int
    jti: str
    iat: float
    clock_skew_s: float
    size_bytes: int
    payload_sha256: str


def _int_field(header: dict, name: str, lo: int, hi: int) -> int:
    v = header.get(name)
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        raise LinkError(f"header '{name}' missing or out of range")
    return v


class LinkRegistry:
    """In-memory session store + envelope verifier. Thread-safe: HTTP workers,
    the AWS IoT bridge thread and background tasks all call into it."""

    def __init__(self, ttl_s: int = SESSION_TTL_S, max_messages: int = MAX_MESSAGES_PER_SESSION,
                 max_skew_s: int = MAX_CLOCK_SKEW_S, replay_window: int = REPLAY_WINDOW,
                 clock: Callable[[], float] = time.time):
        self.ttl_s = ttl_s
        self.max_messages = max_messages
        self.max_skew_s = max_skew_s
        self.replay_window = max(1, replay_window)
        self._clock = clock
        self._sessions: dict[str, LinkSession] = {}
        self._lock = threading.Lock()

    # ---- session lifecycle -------------------------------------------------
    def open_session(self, device_id: str, robot_epk: object, principal: str) -> dict:
        if not isinstance(device_id, str) or not _DEVICE_ID_RE.fullmatch(device_id):
            raise LinkError("invalid device id", public="invalid device id")
        robot_pub = load_public_jwk(robot_epk)

        server_priv = ec.generate_private_key(ec.SECP256R1())
        server_pub = server_priv.public_key()
        shared = server_priv.exchange(ec.ECDH(), robot_pub)
        salt = secrets.token_bytes(32)
        kid = b64u_encode(secrets.token_bytes(16))
        key = derive_session_key(shared, salt, hkdf_info(kid, device_id, raw_point(robot_pub), raw_point(server_pub)))
        # Forward secrecy: drop the ephemeral private key and raw shared secret.
        del server_priv, shared

        now = self._clock()
        session = LinkSession(kid=kid, device_id=device_id, principal=principal, created_at=now,
                              expires_at=now + self.ttl_s, max_messages=self.max_messages, aead=AESGCM(key))
        del key
        with self._lock:
            self._gc(now)
            live = sorted((s for s in self._sessions.values()
                           if s.device_id == device_id and s.state(now) == "active"),
                          key=lambda s: s.created_at)
            # A device keeps at most a few live keys; the oldest are revoked.
            for old in live[: max(0, len(live) - (MAX_SESSIONS_PER_DEVICE - 1))]:
                old.revoked = True
            self._sessions[kid] = session

        return {
            "protocol": PROTOCOL, "kid": kid, "alg": "dir", "enc": "A256GCM", "typ": JWE_TYP,
            "kdf": KDF_LABEL, "server_epk": public_jwk(server_pub), "salt": b64u_encode(salt),
            "device_id": device_id, "expires_at": _iso(session.expires_at), "expires_in": self.ttl_s,
            "max_messages": self.max_messages, "max_clock_skew_s": self.max_skew_s,
            "server_time": now, "content_types": list(CONTENT_TYPES),
        }

    def get(self, kid: str) -> Optional[LinkSession]:
        with self._lock:
            return self._sessions.get(kid)

    def revoke(self, kid: str) -> Optional[LinkSession]:
        with self._lock:
            s = self._sessions.get(kid)
            if s:
                s.revoked = True
            return s

    def list_sessions(self) -> list[dict]:
        now = self._clock()
        with self._lock:
            self._gc(now)
            items = sorted(self._sessions.values(), key=lambda s: s.created_at, reverse=True)
            return [s.public_view(now) for s in items]

    def _gc(self, now: float):
        stale = [k for k, s in self._sessions.items() if now > s.expires_at + SESSION_RETENTION_S]
        for k in stale:
            del self._sessions[k]
        if len(self._sessions) > MAX_TRACKED_SESSIONS:
            for s in sorted(self._sessions.values(), key=lambda s: s.created_at)[: len(self._sessions) - MAX_TRACKED_SESSIONS]:
                del self._sessions[s.kid]

    # ---- envelope verification -------------------------------------------
    def open(self, envelope: Union[bytes, str], expected_device: Optional[str] = None) -> OpenedMessage:
        """Verify and decrypt one JWE compact envelope. Raises LinkError."""
        if isinstance(envelope, (bytes, bytearray)):
            if len(envelope) > MAX_ENVELOPE_BYTES:
                raise LinkError("envelope too large", 413, "envelope too large")
            try:
                envelope = bytes(envelope).decode("ascii")
            except UnicodeDecodeError:
                raise LinkError("envelope is not ASCII") from None
        token = envelope.strip()
        if len(token) > MAX_ENVELOPE_BYTES:
            raise LinkError("envelope too large", 413, "envelope too large")

        parts = token.split(".")
        if len(parts) != 5:
            raise LinkError("not a JWE compact serialization (expected 5 parts)")
        h_b64, ek_b64, iv_b64, ct_b64, tag_b64 = parts
        try:
            header = json.loads(b64u_decode(h_b64))
            iv, ciphertext, tag = b64u_decode(iv_b64), b64u_decode(ct_b64), b64u_decode(tag_b64)
        except ValueError:  # json.JSONDecodeError is a ValueError too
            raise LinkError("malformed envelope encoding") from None
        if not isinstance(header, dict):
            raise LinkError("protected header is not a JSON object")

        # Fixed profile: anything else is refused rather than negotiated.
        if header.get("alg") != "dir" or header.get("enc") != "A256GCM":
            raise LinkError("unsupported alg/enc (profile is dir + A256GCM)")
        if header.get("typ") != JWE_TYP:
            raise LinkError("unexpected typ")
        if "zip" in header:
            raise LinkError("compressed payloads are not accepted")
        if "crit" in header:
            raise LinkError("unsupported critical header parameters")
        if ek_b64 != "":
            raise LinkError("alg dir requires an empty encrypted key")
        if len(iv) != 12 or len(tag) != 16:
            raise LinkError("A256GCM requires a 96-bit IV and 128-bit tag")

        cty = header.get("cty")
        if cty not in CONTENT_TYPES:
            raise LinkError("unsupported content type")
        kid, dev, jti = header.get("kid"), header.get("dev"), header.get("jti")
        if not isinstance(kid, str) or not _KID_RE.fullmatch(kid):
            raise LinkError("header 'kid' missing or malformed")
        if not isinstance(dev, str) or not _DEVICE_ID_RE.fullmatch(dev):
            raise LinkError("header 'dev' missing or malformed")
        if not isinstance(jti, str) or not _JTI_RE.fullmatch(jti):
            raise LinkError("header 'jti' missing or malformed")
        seq = _int_field(header, "seq", 1, _MAX_SEQ)
        iat = header.get("iat")
        if isinstance(iat, bool) or not isinstance(iat, (int, float)):
            raise LinkError("header 'iat' missing")

        now = self._clock()
        with self._lock:
            session = self._sessions.get(kid)
            if session is None or session.state(now) in ("revoked", "expired"):
                raise LinkError("unknown, revoked or expired session", 401, "session invalid or expired")
            if session.state(now) == "exhausted":
                raise LinkError("session message limit reached; re-key required", 401, "session invalid or expired")
            if dev != session.device_id:
                raise LinkError("header 'dev' does not match the session's device")
            if expected_device is not None and expected_device != dev:
                raise LinkError("device does not match the transport identity (topic/cert)")
            skew = float(iat) - now
            if abs(skew) > self.max_skew_s:
                raise LinkError(f"stale or future-dated message (skew {skew:.0f}s)")
            if jti in session.seen_jti:
                raise LinkError("replayed message id (jti)")
            if seq in session.seen_seq:
                raise LinkError(f"replayed sequence number {seq}")
            if seq <= session.last_seq - self.replay_window:
                raise LinkError(f"sequence number {seq} is older than the replay window "
                                f"(latest {session.last_seq}, window {self.replay_window})")
            try:
                plaintext = session.aead.decrypt(iv, ciphertext + tag, h_b64.encode("ascii"))
            except InvalidTag:
                raise LinkError("authentication tag mismatch (tampered or wrong key)") from None
            # Authentic: only now commit replay state.
            session.seen_jti.add(jti)
            session.seen_seq.add(seq)
            if seq > session.last_seq:
                session.last_seq = seq
                floor = seq - self.replay_window
                session.seen_seq = {s for s in session.seen_seq if s > floor}
            session.messages += 1
            session.last_message_at = now
            principal = session.principal

        try:
            payload = json.loads(plaintext)
        except ValueError:
            raise LinkError("decrypted payload is not JSON") from None
        if not isinstance(payload, dict):
            raise LinkError("decrypted payload is not a JSON object")

        return OpenedMessage(
            header=header, payload=payload, kid=kid, device_id=dev, principal=principal,
            content_type=cty, seq=seq, jti=jti, iat=float(iat), clock_skew_s=round(skew, 3),
            size_bytes=len(token), payload_sha256=hashlib.sha256(plaintext).hexdigest(),
        )
