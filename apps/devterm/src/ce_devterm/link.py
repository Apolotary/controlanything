"""Keeps one authenticated WebSocket to the hub alive: hello, welcome, keepalive, reconnect with backoff.

Events go to `on_event(kind, data)` from the link thread:
  ("status", {"state": connecting|online|offline|unauthorized|stopped, "detail": str, "retryIn": s})
  ("message", envelope)
"""
import collections
import random
import threading
import time

from . import proto
from .ws import OP_TEXT, ConnectionClosed, WebSocket, WebSocketError

CLOSE_UNAUTHORIZED = 4401


class Link(object):
    def __init__(self, ws_url, token, on_event, capabilities=None, app=None, role=None,
                 backoff=(0.5, 10.0), ping_interval=20.0, dead_after=45.0, connect_timeout=4.0):
        self.ws_url = ws_url
        self.token = token
        self.on_event = on_event
        self.capabilities = list(capabilities or proto.CAPABILITIES)
        self.app = app
        self.role = role
        self.backoff = backoff
        self.ping_interval = ping_interval
        self.dead_after = dead_after
        self.connect_timeout = connect_timeout
        self.state = "idle"
        self.detail = ""
        self.device_id = None
        self.welcome = None
        self.connected_at = None
        self._ws = None
        self._stop = threading.Event()
        self._thread = None
        self._hello_id = None
        self._fallback_caps = False
        self._outbox = collections.deque(maxlen=64)  # important messages (exec.ack) kept while offline
        self._lock = threading.Lock()

    # ---- lifecycle ----------------------------------------------------------------------------

    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="ce-link", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        ws = self._ws
        if ws:
            ws.close(1000, "bye")
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=3)
        self._set_state("stopped", "")

    def reconnect_now(self):
        """Drop the current socket; the loop reconnects immediately."""
        ws = self._ws
        if ws:
            ws.close(1000, "reconnect")

    @property
    def online(self):
        return self.state == "online"

    # ---- sending ------------------------------------------------------------------------------

    def send(self, type_, payload, to=None, keep=False):
        """Send a message. Returns True if it went out now. keep=True queues it while offline
        (used for exec.ack); everything else (control.event) is dropped when offline, on purpose:
        a stale knob turn must not replay minutes later."""
        msg = proto.envelope(type_, payload, to=to)
        ws = self._ws
        if ws is not None and self.state == "online":
            try:
                ws.send_text(proto.encode(msg))
                return True
            except (ConnectionClosed, WebSocketError, OSError):
                pass
        if keep:
            with self._lock:
                self._outbox.append(msg)
        return False

    def _flush_outbox(self, ws):
        while True:
            with self._lock:
                if not self._outbox:
                    return
                msg = self._outbox.popleft()
            try:
                ws.send_text(proto.encode(msg))
            except (ConnectionClosed, WebSocketError, OSError):
                with self._lock:
                    self._outbox.appendleft(msg)
                return

    # ---- loop ---------------------------------------------------------------------------------

    def _set_state(self, state, detail, **extra):
        self.state = state
        self.detail = detail
        data = {"state": state, "detail": detail}
        data.update(extra)
        try:
            self.on_event("status", data)
        except Exception:  # never let a UI callback kill the link thread
            pass

    def _sleep(self, seconds):
        self._stop.wait(seconds)

    def _run(self):
        attempt = 0
        while not self._stop.is_set():
            self._set_state("connecting", self.ws_url)
            try:
                ws = WebSocket.connect(self.ws_url, timeout=self.connect_timeout)
            except (OSError, WebSocketError) as e:
                attempt += 1
                delay = self._delay(attempt)
                self._set_state("offline", _describe(e), retryIn=round(delay, 1))
                self._sleep(delay)
                continue
            self._ws = ws
            reason = ""
            try:
                self._send_hello(ws, self.capabilities)
                self._read_loop(ws)
            except ConnectionClosed as e:
                reason = "closed %s %s" % (e.code, e.reason)
                if e.code == CLOSE_UNAUTHORIZED or self.state == "unauthorized":
                    self._ws = None
                    self._set_state("unauthorized", e.reason or "token rejected; pair again")
                    return
            except (OSError, WebSocketError) as e:
                reason = _describe(e)
            finally:
                self._ws = None
                ws.abort()
            if self._stop.is_set():
                break
            if self.connected_at and time.time() - self.connected_at > 10:
                attempt = 0
            self.connected_at = None
            attempt += 1
            delay = self._delay(attempt)
            self._set_state("offline", reason or "connection lost", retryIn=round(delay, 1))
            self._sleep(delay)
        self._set_state("stopped", "")

    def _delay(self, attempt):
        lo, hi = self.backoff
        d = min(hi, lo * (2 ** max(0, attempt - 1)))
        return d * random.uniform(0.8, 1.2)

    def _send_hello(self, ws, caps):
        msg = proto.envelope("hello", proto.hello(self.token, caps, app=self.app, role=self.role))
        self._hello_id = msg["id"]
        ws.send_text(proto.encode(msg))

    def _read_loop(self, ws):
        last_ping = time.time()
        while not self._stop.is_set():
            got = ws.recv(timeout=1.0)
            now = time.time()
            if got is None:
                if now - ws.last_rx > self.dead_after:
                    raise ConnectionClosed(1006, "no data from the hub for %d s" % self.dead_after)
                if now - max(last_ping, ws.last_rx) > self.ping_interval:
                    ws.ping(b"ce")
                    last_ping = now
                continue
            opcode, data = got
            if opcode != OP_TEXT:
                continue
            try:
                m = proto.parse(data)
            except proto.ProtocolError:
                continue
            self._on_message(ws, m)

    def _on_message(self, ws, m):
        t = m.get("type")
        p = m.get("payload") or {}
        if t == "welcome":
            self.device_id = p.get("deviceId")
            self.welcome = p
            self.connected_at = time.time()
            self._set_state("online", "%s · %s" % (p.get("name", "?"), p.get("mode", "?")))
            self._flush_outbox(ws)
        elif t == "log" and p.get("level") == "error" and p.get("ref") and p.get("ref") == self._hello_id:
            if p.get("code") == "unauthorized":
                self._set_state("unauthorized", p.get("message") or "token rejected")
            elif p.get("code") == "invalid_message" and not self._fallback_caps:
                # an older hub that does not know "local"/"printer": say hello with the base set
                self._fallback_caps = True
                self._send_hello(ws, proto.BASE_CAPS)
        try:
            self.on_event("message", m)
        except Exception:
            pass


def _describe(e):
    s = str(e) or e.__class__.__name__
    if isinstance(e, ConnectionRefusedError):
        return "connection refused (is the server running?)"
    if "timed out" in s:
        return "timed out"
    return s[:160]
