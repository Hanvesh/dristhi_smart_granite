"""Unit tests for the secure robot link, driven by the robot's real client."""
import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from drishti_link import RobotLink
from secure_link import LinkError, LinkRegistry, b64u_decode, b64u_encode, public_jwk

DEVICE = "DRISHTI-BOT-01"


class DirectHttp:
    """Routes the robot client's HTTP calls straight into a LinkRegistry."""

    def __init__(self, registry: LinkRegistry):
        self.registry = registry

    def __call__(self, url, body, headers):
        if url.endswith("/robot-link/sessions"):
            req = json.loads(body)
            try:
                return 200, self.registry.open_session(req["device_id"], req["epk"], "robotop")
            except LinkError as e:
                return 400, {"detail": e.public}
        if url.endswith("/robot-link/ingest"):
            try:
                msg = self.registry.open(body)
                return 202, {"status": "accepted", "seq": msg.seq, "kid": msg.kid}
            except LinkError as e:
                return e.status, {"detail": e.public}
        return 404, {}


def make(clock=time.time, **kw):
    reg = LinkRegistry(clock=clock, **kw)
    robot = RobotLink("", DEVICE, "demo.robotop.robot-operator", http=DirectHttp(reg), clock=clock)
    return reg, robot


def _mutate_header(token: str, **changes) -> str:
    parts = token.split(".")
    header = json.loads(b64u_decode(parts[0]))
    header.update(changes)
    parts[0] = b64u_encode(json.dumps(header).encode())
    return ".".join(parts)


def test_round_trip_decrypts_exact_payload():
    reg, robot = make()
    payload = {"reading": 1.234, "nested": {"ok": True}}
    msg = reg.open(robot.seal("capture", payload))
    assert msg.payload == payload
    assert (msg.device_id, msg.seq, msg.content_type, msg.principal) == (DEVICE, 1, "capture", "robotop")


def test_envelope_is_jwe_compact_dir_a256gcm_and_hides_the_payload():
    _, robot = make()
    token = robot.seal("capture", {"secret_reading": 12.345})
    parts = token.split(".")
    assert len(parts) == 5 and parts[1] == ""  # dir => empty encrypted key
    header = json.loads(b64u_decode(parts[0]))
    assert (header["alg"], header["enc"], header["dev"]) == ("dir", "A256GCM", DEVICE)
    assert len(b64u_decode(parts[2])) == 12   # 96-bit IV
    assert len(b64u_decode(parts[4])) == 16   # 128-bit tag
    assert "secret_reading" not in token and "12.345" not in token


def test_ivs_are_unique_per_message():
    _, robot = make()
    ivs = {robot.seal("capture", {"i": i}).split(".")[2] for i in range(50)}
    assert len(ivs) == 50


def test_session_metadata_never_exposes_key_material():
    reg, robot = make()
    offer = robot.open_session()
    assert set(offer["server_epk"]) == {"kty", "crv", "x", "y"}
    view = reg.list_sessions()[0]
    assert view["kid"] == offer["kid"] and view["state"] == "active"
    assert not any("key" in k or "aead" in k for k in view)


@pytest.mark.parametrize("segment", ["header", "iv", "ciphertext", "tag"])
def test_any_tampered_segment_is_rejected_without_poisoning_replay_state(segment):
    reg, robot = make()
    token = robot.seal("capture", {"x": 1})
    if segment == "header":
        forged = _mutate_header(token, seq=99)
    else:
        idx = {"iv": 2, "ciphertext": 3, "tag": 4}[segment]
        parts = token.split(".")
        raw = bytearray(b64u_decode(parts[idx]))
        raw[0] ^= 0x01
        parts[idx] = b64u_encode(bytes(raw))
        forged = ".".join(parts)
    with pytest.raises(LinkError) as ei:
        reg.open(forged)
    assert "authentication tag mismatch" in ei.value.reason
    # The forged attempt must not have consumed the genuine message's jti/seq.
    assert reg.open(token).seq == 1


def test_replayed_envelope_is_rejected():
    reg, robot = make()
    token = robot.seal("capture", {"x": 1})
    reg.open(token)
    with pytest.raises(LinkError) as ei:
        reg.open(token)
    assert "replayed" in ei.value.reason


def test_sliding_replay_window_tolerates_reordering_but_not_replays():
    reg, robot = make(replay_window=4)
    tokens = [robot.seal("capture", {"n": i}) for i in range(1, 8)]  # seq 1..7
    reg.open(tokens[1])                      # seq 2 arrives first (MQTT reordering)
    assert reg.open(tokens[0]).seq == 1      # seq 1 late but inside the window: accepted once
    with pytest.raises(LinkError):
        reg.open(tokens[0])                  # ...and never again
    reg.open(tokens[6])                      # seq 7: window now covers 4..7
    with pytest.raises(LinkError) as ei:
        reg.open(tokens[2])                  # seq 3 fell out of the window
    assert "replay window" in ei.value.reason
    assert reg.open(tokens[4]).seq == 5      # unseen and inside the window


def test_same_sequence_number_cannot_be_reused_with_a_new_jti():
    reg, robot = make()
    token = robot.seal("capture", {"n": 1})
    reg.open(token)
    robot.seq = 0  # a buggy/compromised sender reusing seq 1 under a fresh jti
    with pytest.raises(LinkError) as ei:
        reg.open(robot.seal("capture", {"n": 2}))
    assert "replayed sequence number" in ei.value.reason


def test_stale_and_future_dated_messages_are_rejected():
    now = [1_800_000_000.0]
    reg, robot = make(clock=lambda: now[0])
    stale = robot.seal("capture", {"x": 1})
    now[0] += 301  # just past the 5-minute window
    with pytest.raises(LinkError) as ei:
        reg.open(stale)
    assert "stale or future-dated" in ei.value.reason

    reg2, robot2 = make(clock=lambda: now[0])
    future = robot2.seal("capture", {"x": 2})
    now[0] -= 400  # gateway clock is now well behind the message's iat
    with pytest.raises(LinkError):
        reg2.open(future)


def test_expired_session_is_401_and_the_client_rekeys():
    now = [1_800_000_000.0]
    reg, robot = make(clock=lambda: now[0], ttl_s=120)
    first_kid = robot.open_session()["kid"]
    token = robot.seal("capture", {"x": 1})
    now[0] += 121
    with pytest.raises(LinkError) as ei:
        reg.open(token)
    assert ei.value.status == 401
    assert robot.send("capture", {"x": 2})["status"] == "accepted"
    assert robot.session["kid"] != first_kid


def test_revoked_session_is_rejected_and_the_client_recovers():
    reg, robot = make()
    kid = robot.open_session()["kid"]
    reg.revoke(kid)
    with pytest.raises(LinkError) as ei:
        reg.open(robot.seal("capture", {"x": 0}))
    assert ei.value.status == 401
    assert robot.send("capture", {"x": 1})["status"] == "accepted"  # 401 -> re-key -> resend


def test_server_enforces_the_per_key_message_cap():
    reg, robot = make(max_messages=2)
    robot.open_session()
    robot.session["max_messages"] = 10**6  # a misbehaving client that never re-keys
    tokens = [robot.seal("capture", {"i": i}) for i in range(3)]
    reg.open(tokens[0])
    reg.open(tokens[1])
    with pytest.raises(LinkError) as ei:
        reg.open(tokens[2])
    assert ei.value.status == 401 and "limit" in ei.value.reason


def test_client_rekeys_before_exhausting_the_budget():
    _, robot = make(max_messages=3)
    first_kid = robot.open_session()["kid"]
    for i in range(3):
        robot.send("capture", {"i": i})
    assert robot.session["kid"] != first_kid


def test_device_must_match_the_transport_identity():
    reg, robot = make()
    with pytest.raises(LinkError) as ei:
        reg.open(robot.seal("capture", {"x": 1}), expected_device="DRISHTI-BOT-02")
    assert "transport identity" in ei.value.reason


@pytest.mark.parametrize("changes", [
    {"alg": "none"}, {"enc": "A128GCM"}, {"typ": "JWT"}, {"zip": "DEF"},
    {"crit": ["exp"]}, {"cty": "blocks"}, {"dev": "DRISHTI-BOT-02"},
])
def test_header_profile_is_enforced(changes):
    reg, robot = make()
    with pytest.raises(LinkError):
        reg.open(_mutate_header(robot.seal("capture", {"x": 1}), **changes))


def test_handshake_refuses_invalid_curve_points_and_private_keys():
    reg = LinkRegistry()
    off_curve = {"kty": "EC", "crv": "P-256", "x": b64u_encode(b"\x01" * 32), "y": b64u_encode(b"\x02" * 32)}
    with pytest.raises(LinkError):
        reg.open_session(DEVICE, off_curve, "robotop")
    priv = ec.generate_private_key(ec.SECP256R1())
    leaked = {**public_jwk(priv.public_key()),
              "d": b64u_encode(priv.private_numbers().private_value.to_bytes(32, "big"))}
    with pytest.raises(LinkError) as ei:
        reg.open_session(DEVICE, leaked, "robotop")
    assert "private key" in ei.value.public
    with pytest.raises(LinkError):
        reg.open_session("not a device!", public_jwk(priv.public_key()), "robotop")


@pytest.mark.parametrize("bad", ["", "a.b.c", "!!.x.y.z.w", "e30..AAAA.AAAA.AAAA", "e30.x.y.z.w"])
def test_malformed_envelopes_are_rejected(bad):
    with pytest.raises(LinkError):
        LinkRegistry().open(bad)


def test_oversized_envelope_is_413():
    with pytest.raises(LinkError) as ei:
        LinkRegistry().open(b"a" * (64 * 1024 + 1))
    assert ei.value.status == 413
