"""
Robot-side client for the DRISHTI secure robot link (drishti-robot-link/v1).

The robot only captures and transmits. This module does the transmitting:

  1. open_session(): ephemeral ECDH P-256 key agreement with the gateway
     (POST /robot-link/sessions, authenticated with the operator token), then
     HKDF-SHA256 -> 256-bit AES key. The key never crosses the network.
  2. seal(): wrap a raw payload in a JWE compact envelope (alg "dir",
     enc "A256GCM", random 96-bit IV, protected header as AAD) carrying the
     session key id, device id, a strictly increasing sequence number, a
     single-use message id (jti) and the issue time (iat).
  3. send(): POST the envelope to /robot-link/ingest (or hand it to MQTT).
     Re-keys automatically when the session nears expiry or its message cap,
     and once on a 401 from the gateway.

The browser Robot View implements the same protocol with WebCrypto in
apps/robot-console/src/secureLink.ts. Requires: cryptography (pyca).
"""
from __future__ import annotations

import base64
import json
import secrets
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Callable, Optional, Protocol

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PROTOCOL = "drishti-robot-link/v1"
JWE_TYP = "drishti-robot-msg+jwe"
REKEY_MARGIN_S = 60        # re-key this long before the session expires
REKEY_AT_FRACTION = 0.9    # ...or once 90% of the message budget is used


class LinkClientError(Exception):
    def __init__(self, message: str, status: Optional[int] = None, body: Optional[dict] = None):
        super().__init__(message)
        self.status = status
        self.body = body or {}


class HttpPost(Protocol):
    def __call__(self, url: str, body: bytes, headers: dict) -> tuple[int, dict]: ...


def urllib_post(url: str, body: bytes, headers: dict, timeout: float = 10.0) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode() or "{}")
        except ValueError:
            data = {}
        return e.code, data


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _raw_point(pub: ec.EllipticCurvePublicKey) -> bytes:
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


class RobotLink:
    def __init__(self, gateway: str, device_id: str, token: str,
                 http: Optional[HttpPost] = None, clock: Callable[[], float] = time.time):
        self.gateway = gateway.rstrip("/")
        self.device_id = device_id
        self.token = token
        self.http = http or urllib_post
        self.clock = clock
        self._aead: Optional[AESGCM] = None
        self.session: Optional[dict] = None
        self.seq = 0
        self.messages = 0
        self._clock_offset = 0.0
        self._lock = threading.Lock()

    # ---- session -------------------------------------------------------
    def open_session(self) -> dict:
        priv = ec.generate_private_key(ec.SECP256R1())
        pub = priv.public_key()
        raw = _raw_point(pub)
        epk = {"kty": "EC", "crv": "P-256", "x": b64u(raw[1:33]), "y": b64u(raw[33:65])}
        status, body = self.http(
            f"{self.gateway}/robot-link/sessions",
            json.dumps({"device_id": self.device_id, "epk": epk}).encode(),
            {"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
        )
        if status != 200:
            raise LinkClientError(f"session request failed: {status} {body.get('detail')}", status, body)
        if (body.get("protocol"), body.get("alg"), body.get("enc"), body.get("typ")) != (PROTOCOL, "dir", "A256GCM", JWE_TYP):
            raise LinkClientError("gateway offered an unexpected protocol profile")

        sepk = body["server_epk"]
        server_pub = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), b"\x04" + b64u_decode(sepk["x"]) + b64u_decode(sepk["y"]))
        shared = priv.exchange(ec.ECDH(), server_pub)
        info = b"\x00".join([PROTOCOL.encode(), body["kid"].encode(), self.device_id.encode(),
                             raw, _raw_point(server_pub)])
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b64u_decode(body["salt"]), info=info).derive(shared)
        del priv, shared

        self._aead = AESGCM(key)
        self.session = body
        self.seq = 0
        self.messages = 0
        # Align iat with gateway time learned over the authenticated channel.
        self._clock_offset = float(body.get("server_time", self.clock())) - self.clock()
        self._expires_local = self.clock() + float(body["expires_in"])
        return body

    def _needs_rekey(self) -> bool:
        if not self.session or not self._aead:
            return True
        if self.clock() >= self._expires_local - REKEY_MARGIN_S:
            return True
        return self.messages >= int(self.session["max_messages"] * REKEY_AT_FRACTION)

    def ensure_session(self):
        if self._needs_rekey():
            self.open_session()

    # ---- messages ------------------------------------------------------
    def seal(self, content_type: str, payload: dict) -> str:
        """Return a JWE compact envelope for one payload (advances seq)."""
        self.ensure_session()
        assert self._aead is not None and self.session is not None
        self.seq += 1
        self.messages += 1
        header = {
            "alg": "dir", "enc": "A256GCM", "typ": JWE_TYP, "cty": content_type,
            "kid": self.session["kid"], "dev": self.device_id, "seq": self.seq,
            "jti": str(uuid.uuid4()), "iat": int(self.clock() + self._clock_offset),
        }
        h = b64u(json.dumps(header, separators=(",", ":")).encode())
        iv = secrets.token_bytes(12)
        out = self._aead.encrypt(iv, json.dumps(payload, separators=(",", ":")).encode(), h.encode("ascii"))
        return ".".join([h, "", b64u(iv), b64u(out[:-16]), b64u(out[-16:])])

    def send_envelope(self, envelope: str) -> tuple[int, dict]:
        return self.http(f"{self.gateway}/robot-link/ingest", envelope.encode("ascii"),
                         {"Content-Type": "application/jose"})

    def send(self, content_type: str, payload: dict) -> dict:
        """Seal + POST, re-keying once if the gateway says the session is gone."""
        with self._lock:
            status, body = self.send_envelope(self.seal(content_type, payload))
            if status == 401:
                self.session = None
                status, body = self.send_envelope(self.seal(content_type, payload))
        if status not in (200, 202):
            raise LinkClientError(f"transmission rejected: {status} {body.get('detail')}", status, body)
        return body

    def close(self):
        """Revoke the session key on the gateway (best effort)."""
        if not self.session:
            return
        req = urllib.request.Request(
            f"{self.gateway}/robot-link/sessions/{self.session['kid']}", method="DELETE",
            headers={"Authorization": f"Bearer {self.token}"})
        try:
            urllib.request.urlopen(req, timeout=5).close()
        except Exception:
            pass
        self.session = None
        self._aead = None
