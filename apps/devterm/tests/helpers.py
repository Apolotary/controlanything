"""Test doubles: a tiny WebSocket server (server side of RFC 6455) and a fake pairing API."""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import time

try:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlsplit
except ImportError:  # pragma: no cover
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from ce_devterm import ws as wsmod  # noqa: E402

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class ServerConn(object):
    """The server end of one WebSocket connection."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = bytearray()
        self.request = ""
        self.closed = False

    def _read(self, n, timeout=3.0):
        deadline = time.time() + timeout
        while len(self.buf) < n:
            left = deadline - time.time()
            if left <= 0:
                raise socket.timeout("timed out")
            self.sock.settimeout(left)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("client closed")
            self.buf += chunk
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def handshake(self, accept=None, status_line="HTTP/1.1 101 Switching Protocols"):
        raw = bytearray()
        while b"\r\n\r\n" not in raw:
            self.sock.settimeout(3)
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("no handshake")
            raw += chunk
        head, _, rest = bytes(raw).partition(b"\r\n\r\n")
        self.buf += rest
        self.request = head.decode("latin-1")
        key = ""
        for line in self.request.split("\r\n")[1:]:
            name, _, value = line.partition(":")
            if name.strip().lower() == "sec-websocket-key":
                key = value.strip()
        if accept is None:
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        resp = "%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % (status_line, accept)
        self.sock.sendall(resp.encode("latin-1"))

    def send_raw(self, data):
        self.sock.sendall(data)

    def send_frame(self, opcode, payload, fin=True):
        self.sock.sendall(wsmod.build_frame(opcode, payload, fin=fin, mask=False))

    def send_text(self, text):
        self.send_frame(wsmod.OP_TEXT, text.encode("utf-8"))

    def send_json(self, obj):
        self.send_text(json.dumps(obj))

    def recv_frame(self, timeout=3.0):
        b0, b1 = self._read(2, timeout)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read(2, timeout))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read(8, timeout))[0]
        key = self._read(4, timeout) if masked else None
        payload = self._read(n, timeout)
        if key:
            payload = wsmod.mask_payload(key, payload)
        return fin, opcode, payload, masked

    def recv_message(self, timeout=3.0):
        """Next data message (handles pings/continuations); None when the client sent close."""
        parts = []
        op = None
        while True:
            fin, opcode, payload, masked = self.recv_frame(timeout)
            if not masked:
                raise AssertionError("client frame was not masked")
            if opcode == wsmod.OP_CLOSE:
                self.closed = True
                return None
            if opcode == wsmod.OP_PING:
                self.send_frame(wsmod.OP_PONG, payload)
                continue
            if opcode == wsmod.OP_PONG:
                continue
            if opcode != wsmod.OP_CONT:
                op = opcode
            parts.append(payload)
            if fin:
                data = b"".join(parts)
                return (op, data.decode("utf-8") if op == wsmod.OP_TEXT else data)

    def recv_json(self, timeout=3.0):
        m = self.recv_message(timeout)
        if m is None:
            return None
        return json.loads(m[1])

    def close(self, code=1000, reason=""):
        try:
            self.send_frame(wsmod.OP_CLOSE, struct.pack(">H", code) + reason.encode())
        except OSError:
            pass

    def shutdown(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


class WsTestServer(object):
    """Accepts connections on 127.0.0.1 and runs handler(conn) per connection in a thread."""

    def __init__(self, handler):
        self.handler = handler
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.conns = []
        self.errors = []
        self._stop = False
        self._t = threading.Thread(target=self._accept, daemon=True)
        self._t.start()

    @property
    def url(self):
        return "ws://127.0.0.1:%d/ws" % self.port

    def _accept(self):
        while not self._stop:
            try:
                s, _ = self.sock.accept()
            except OSError:
                return
            c = ServerConn(s)
            self.conns.append(c)
            threading.Thread(target=self._run, args=(c,), daemon=True).start()

    def _run(self, c):
        try:
            self.handler(c)
        except Exception as e:  # recorded for the test to inspect
            self.errors.append(e)

    def stop(self):
        self._stop = True
        try:
            self.sock.close()
        except OSError:
            pass
        for c in self.conns:
            try:
                c.shutdown()
            except OSError:
                pass


class FakeHub(object):
    """Hub behaviour for Link tests: hello -> welcome (good token) or log + close 4401 (bad token)."""

    def __init__(self, good_token="good", reject_caps=None):
        self.good_token = good_token
        self.reject_caps = reject_caps  # a capability whose presence makes hello "invalid"
        self.received = []
        self.live = []
        self.connections = 0
        self.server = WsTestServer(self._handle)

    def _handle(self, c):
        c.handshake()
        self.connections += 1
        self.live.append(c)
        while True:
            try:
                m = c.recv_json(timeout=30)
            except (EOFError, OSError, socket.timeout):
                return
            if m is None:
                c.close()
                return
            self.received.append(m)
            if m.get("type") == "hello":
                p = m.get("payload") or {}
                if p.get("deviceToken") != self.good_token:
                    c.send_json(_env("log", {"level": "error", "code": "unauthorized", "message": "nope", "ref": m["id"]}))
                    c.close(4401, "unauthorized")
                    return
                if self.reject_caps and self.reject_caps in (p.get("capabilities") or []):
                    c.send_json(_env("log", {"level": "error", "code": "invalid_message", "message": "bad caps", "ref": m["id"]}))
                    continue
                c.send_json(_env("welcome", {"clientId": "c1", "deviceId": "dev-1", "name": "DevTerm", "kind": "devterm",
                                             "role": "device", "canApprove": False, "spaceId": "s1", "protocol": 1,
                                             "server": "fake", "mode": "fixture"}))

    def push(self, obj):
        for c in list(self.live):
            try:
                c.send_json(obj)
            except OSError:
                pass

    def stop(self):
        self.server.stop()


def _env(type_, payload, to=None):
    m = {"v": 1, "type": type_, "id": "m-%s" % time.time(), "ts": int(time.time() * 1000), "from": "server", "payload": payload}
    if to:
        m["to"] = to
    return m


env = _env


def wait_for(cond, timeout=3.0, step=0.02):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(step)
    return cond()


class FakeApi(object):
    """The pairing endpoints: approve after `approve_after` polls; reject unknown capabilities if asked."""

    def __init__(self, approve_after=2, auto_approve=False, strict_caps=None, deny=False):
        self.approve_after = approve_after
        self.auto_approve = auto_approve
        self.strict_caps = strict_caps
        self.deny = deny
        self.polls = 0
        self.starts = []
        self.token_taken = False
        api = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n).decode() or "{}")
                if self.path == "/api/pair/start":
                    api.starts.append(body)
                    if api.strict_caps is not None and any(c not in api.strict_caps for c in body.get("capabilities") or []):
                        return self._json(400, {"error": "bad_request", "message": "capabilities.0: invalid enum"})
                    resp = {"pairingId": "pid1", "code": "K7Q4M2", "display": "K7Q-4M2", "qr": "https://mac:8443/p/pid1#K7Q4M2",
                            "expiresAt": int((time.time() + 300) * 1000), "pollSecret": "sec", "status": "pending"}
                    if api.auto_approve:
                        resp.update(status="approved", deviceId="dev-9", deviceToken="tok-9")
                    return self._json(201, resp)
                self._json(404, {"error": "not_found"})

            def do_GET(self):
                u = urlsplit(self.path)
                q = parse_qs(u.query)
                if u.path == "/api/pair/status":
                    if q.get("pollSecret") != ["sec"]:
                        return self._json(403, {"error": "bad_secret", "message": "bad secret"})
                    api.polls += 1
                    if api.deny:
                        return self._json(200, {"pairingId": "pid1", "status": "denied", "expiresAt": 0, "reason": "denied"})
                    if api.polls >= api.approve_after:
                        resp = {"pairingId": "pid1", "status": "approved", "expiresAt": 0}
                        if not api.token_taken:
                            api.token_taken = True
                            resp.update(deviceId="dev-9", deviceToken="tok-9")
                        return self._json(200, resp)
                    return self._json(200, {"pairingId": "pid1", "status": "pending", "expiresAt": int((time.time() + 300) * 1000)})
                if u.path == "/api/health":
                    return self._json(200, {"ok": True, "version": "0.1.0", "mode": "fixture", "protocol": 1,
                                            "urls": {"lan": ["10.0.0.5"]}})
                if u.path == "/api/me":
                    if self.headers.get("authorization") == "Bearer tok-9":
                        return self._json(200, {"device": {"deviceId": "dev-9"}})
                    return self._json(401, {"error": "unauthorized", "message": "Unknown or revoked device token."})
                self._json(404, {"error": "not_found", "message": "no route"})

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self._t = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._t.start()

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.port

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
