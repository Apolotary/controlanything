"""The ControlEverything wire envelope (packages/protocol): {v: 1, type, id, ts, from, to?, payload}.

The hub stamps `from`, validates known types with the shared schemas (additionalProperties: false, so
we never add fields the schema does not list) and relays experimental `x.*` types unchecked.
"""
import binascii
import json
import os
import time

PROTOCOL_VERSION = 1
SERVER = "server"
APP_NAME = "ce-devterm"

# What this client can do for the agent (packages/protocol Capability). "local" = executes LocalOps on
# itself (say, beep, screen); "printer" = LocalOp print. BASE_CAPS is the fallback for a server whose
# schema predates protocol v1.
CAPABILITIES = ["display", "speaker", "wifi", "local", "printer"]
BASE_CAPS = ["display", "speaker", "wifi"]

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n):
    if n <= 0:
        return "0"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(_B36[r])
    return "".join(reversed(out))


def new_id(prefix="m"):
    """Same shape as the TypeScript newId(): base36 time + 18 hex chars of randomness."""
    return "%s%s%s" % (prefix, _base36(int(time.time() * 1000)), binascii.hexlify(os.urandom(9)).decode("ascii"))


def envelope(type_, payload, to=None, id_=None, ts=None):
    m = {
        "v": PROTOCOL_VERSION,
        "type": type_,
        "id": id_ or new_id("m"),
        "ts": int(ts if ts is not None else time.time() * 1000),
        "from": "",
        "payload": payload,
    }
    if to:
        m["to"] = to
    return m


def encode(msg):
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":"))


class ProtocolError(ValueError):
    pass


def parse(text):
    """Parse one message from the socket. Raises ProtocolError on anything that is not an envelope."""
    try:
        m = json.loads(text)
    except ValueError:
        raise ProtocolError("not JSON")
    if not isinstance(m, dict):
        raise ProtocolError("not an object")
    if m.get("v") != PROTOCOL_VERSION:
        raise ProtocolError("unsupported protocol version %r" % (m.get("v"),))
    if not isinstance(m.get("type"), str) or not m["type"]:
        raise ProtocolError("missing type")
    if not isinstance(m.get("payload"), dict):
        m["payload"] = {} if m.get("payload") is None else {"value": m.get("payload")}
    return m


# ---- payload builders (kept to the exact schema fields) ------------------------------------------

def hello(token, capabilities=None, app=None, role=None):
    p = {"deviceToken": token, "capabilities": list(capabilities or CAPABILITIES)}
    if app:
        p["app"] = app
    if role:
        p["role"] = role
    return p


def control_event(widget_id, value, spec_id=None, phase=None, index=None, ts=None):
    p = {"widgetId": str(widget_id)[:64], "value": value, "ts": int(ts if ts is not None else time.time() * 1000)}
    if spec_id:
        p["specId"] = spec_id
    if phase:
        p["phase"] = phase
    if index is not None:
        p["index"] = int(index)
    return p


def exec_ack(exec_id, ok, sent_at_ms, detail=None, error=None, latency_ms=None):
    p = {"execId": exec_id, "ok": bool(ok), "sentAt": int(sent_at_ms)}
    if detail:
        p["detail"] = str(detail)[:1000]
    if error:
        p["error"] = error
    if latency_ms is not None:
        p["latencyMs"] = max(0, int(latency_ms))
    return p


EXEC_ERRORS = ("no_port", "no_midi", "no_ir", "bad_args", "rate_limited", "unsupported", "serial_offline",
               "timeout", "device_error", "refused")
