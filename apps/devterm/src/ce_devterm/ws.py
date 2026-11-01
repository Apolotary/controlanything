"""A small RFC 6455 WebSocket client on the standard library (no TLS: the hub's plain ws:// port).

Client frames are masked; server frames are parsed from an internal buffer, so a recv() timeout in the
middle of a frame loses nothing. Fragmented messages are reassembled, pings are answered with pongs,
and the close handshake is echoed. One thread may call recv() while others call send_*().
"""
import base64
import hashlib
import os
import socket
import struct
import threading
import time

try:
    from urllib.parse import urlsplit
except ImportError:  # pragma: no cover
    from urlparse import urlsplit  # type: ignore

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_MESSAGE = 16 * 1024 * 1024
MAX_HEADER = 16 * 1024


class WebSocketError(Exception):
    pass


class HandshakeError(WebSocketError):
    def __init__(self, message, status=None):
        WebSocketError.__init__(self, message)
        self.status = status


class ConnectionClosed(WebSocketError):
    def __init__(self, code=1006, reason=""):
        WebSocketError.__init__(self, "closed %s%s" % (code, (": " + reason) if reason else ""))
        self.code = code
        self.reason = reason


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")


def mask_payload(key, data):
    """XOR `data` with the 4-byte masking key (big-integer XOR: fast enough in pure Python)."""
    n = len(data)
    if n == 0:
        return b""
    k = (bytes(key) * (n // 4 + 1))[:n]
    return (int.from_bytes(bytes(data), "big") ^ int.from_bytes(k, "big")).to_bytes(n, "big")


def build_frame(opcode, payload, fin=True, mask=True, mask_key=None):
    payload = bytes(payload)
    n = len(payload)
    head = bytearray([(0x80 if fin else 0) | (opcode & 0x0F)])
    mbit = 0x80 if mask else 0
    if n < 126:
        head.append(mbit | n)
    elif n < 65536:
        head.append(mbit | 126)
        head += struct.pack(">H", n)
    else:
        head.append(mbit | 127)
        head += struct.pack(">Q", n)
    if mask:
        key = mask_key if mask_key is not None else os.urandom(4)
        head += key
        payload = mask_payload(key, payload)
    return bytes(head) + payload


def _close_payload(code, reason):
    if code is None:
        return b""
    return struct.pack(">H", code) + reason.encode("utf-8")[:120]


class WebSocket(object):
    def __init__(self, sock, buffered=b"", max_message=MAX_MESSAGE):
        self.sock = sock
        self._buf = bytearray(buffered)
        self._send_lock = threading.Lock()
        self._frag_opcode = None
        self._frag = []
        self._frag_len = 0
        self.max_message = max_message
        self.closed = False
        self.close_sent = False
        self.close_code = None
        self.close_reason = ""
        self.last_rx = time.time()
        self.last_pong = None

    # ---- connect ----------------------------------------------------------------------------

    @classmethod
    def connect(cls, url, timeout=10.0, headers=None, max_message=MAX_MESSAGE):
        parts = urlsplit(url)
        if parts.scheme != "ws":
            raise WebSocketError("only ws:// URLs are supported, got %r" % url)
        host = parts.hostname
        port = parts.port or 80
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        sock = socket.create_connection((host, port), timeout=timeout)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        except (OSError, AttributeError):
            pass
        try:
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            host_header = host if port == 80 else "%s:%d" % (("[%s]" % host) if ":" in host else host, port)
            lines = [
                "GET %s HTTP/1.1" % path,
                "Host: %s" % host_header,
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Sec-WebSocket-Key: %s" % key,
                "Sec-WebSocket-Version: 13",
            ]
            for k, v in (headers or {}).items():
                lines.append("%s: %s" % (k, v))
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            raw = bytearray()
            deadline = time.time() + timeout
            while b"\r\n\r\n" not in raw:
                left = deadline - time.time()
                if left <= 0:
                    raise HandshakeError("no handshake reply within %.0f s" % timeout)
                sock.settimeout(left)
                chunk = sock.recv(4096)
                if not chunk:
                    raise HandshakeError("server closed the connection during the handshake")
                raw += chunk
                if len(raw) > MAX_HEADER:
                    raise HandshakeError("handshake reply too large")
            end = raw.index(b"\r\n\r\n")
            head = raw[:end].decode("latin-1")
            rest = bytes(raw[end + 4:])
            status_line, _, header_text = head.partition("\r\n")
            bits = status_line.split(" ", 2)
            status = int(bits[1]) if len(bits) > 1 and bits[1].isdigit() else 0
            if status != 101:
                raise HandshakeError("handshake refused: %s" % status_line.strip(), status)
            hdrs = {}
            for line in header_text.split("\r\n"):
                name, sep, value = line.partition(":")
                if sep:
                    hdrs[name.strip().lower()] = value.strip()
            if hdrs.get("upgrade", "").lower() != "websocket":
                raise HandshakeError("server did not upgrade to websocket", status)
            if "upgrade" not in [t.strip().lower() for t in hdrs.get("connection", "").split(",")]:
                raise HandshakeError("missing Connection: Upgrade", status)
            if hdrs.get("sec-websocket-accept") != accept_key(key):
                raise HandshakeError("bad Sec-WebSocket-Accept", status)
            sock.settimeout(None)
            return cls(sock, rest, max_message=max_message)
        except BaseException:
            try:
                sock.close()
            except OSError:
                pass
            raise

    # ---- send -------------------------------------------------------------------------------

    def _send(self, opcode, payload):
        if self.closed:
            raise ConnectionClosed(self.close_code or 1006, self.close_reason or "already closed")
        frame = build_frame(opcode, payload)
        with self._send_lock:
            try:
                self.sock.sendall(frame)
            except (OSError, socket.timeout) as e:
                self.abort()
                raise ConnectionClosed(1006, "send failed: %s" % e)

    def send_text(self, text):
        self._send(OP_TEXT, text.encode("utf-8"))

    def send_binary(self, data):
        self._send(OP_BINARY, data)

    def ping(self, data=b""):
        self._send(OP_PING, data[:125])

    def close(self, code=1000, reason=""):
        """Start the close handshake (best effort) and drop the connection."""
        if self.closed:
            return
        try:
            if not self.close_sent:
                self.close_sent = True
                with self._send_lock:
                    self.sock.sendall(build_frame(OP_CLOSE, _close_payload(code, reason)))
        except (OSError, socket.timeout):
            pass
        self.close_code = self.close_code or code
        self.close_reason = self.close_reason or reason
        self.abort()

    def abort(self):
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    # ---- receive ----------------------------------------------------------------------------

    def recv(self, timeout=None):
        """The next complete data message as (opcode, data): text -> str, binary -> bytes.

        Returns None when `timeout` seconds pass without a complete message. Raises ConnectionClosed
        when the peer closes (code/reason set) or the socket fails.
        """
        deadline = None if timeout is None else time.time() + timeout
        while True:
            if self.closed:
                raise ConnectionClosed(self.close_code or 1006, self.close_reason)
            frame = self._parse_frame()
            if frame is None:
                left = None if deadline is None else deadline - time.time()
                if left is not None and left <= 0:
                    return None
                if not self._fill(left):
                    return None
                continue
            fin, opcode, payload = frame
            if opcode == OP_PING:
                try:
                    self._send(OP_PONG, payload)
                except ConnectionClosed:
                    raise
                continue
            if opcode == OP_PONG:
                self.last_pong = time.time()
                continue
            if opcode == OP_CLOSE:
                code, reason = 1005, ""
                if len(payload) >= 2:
                    code = struct.unpack(">H", payload[:2])[0]
                    reason = payload[2:].decode("utf-8", "replace")
                self.close_code, self.close_reason = code, reason
                if not self.close_sent:
                    self.close_sent = True
                    try:
                        with self._send_lock:
                            self.sock.sendall(build_frame(OP_CLOSE, _close_payload(None if code == 1005 else code, "")))
                    except (OSError, socket.timeout):
                        pass
                self.abort()
                raise ConnectionClosed(code, reason)
            if opcode == OP_CONT:
                if self._frag_opcode is None:
                    self._fail(1002, "continuation frame without a message")
                self._frag.append(payload)
                self._frag_len += len(payload)
                if self._frag_len > self.max_message:
                    self._fail(1009, "message too big")
                if fin:
                    data = b"".join(self._frag)
                    op = self._frag_opcode
                    self._frag_opcode, self._frag, self._frag_len = None, [], 0
                    return self._deliver(op, data)
                continue
            if opcode in (OP_TEXT, OP_BINARY):
                if self._frag_opcode is not None:
                    self._fail(1002, "new message before the fragmented one ended")
                if fin:
                    return self._deliver(opcode, payload)
                self._frag_opcode, self._frag, self._frag_len = opcode, [payload], len(payload)
                continue
            self._fail(1002, "unknown opcode %d" % opcode)

    def _deliver(self, opcode, data):
        if opcode == OP_TEXT:
            try:
                return opcode, data.decode("utf-8")
            except UnicodeDecodeError:
                self._fail(1007, "invalid UTF-8 in a text message")
        return opcode, data

    def _fail(self, code, reason):
        self.close(code, reason)
        raise ConnectionClosed(code, reason)

    def _fill(self, timeout):
        try:
            self.sock.settimeout(timeout)
            data = self.sock.recv(65536)
        except socket.timeout:
            return False
        except OSError as e:
            self.abort()
            raise ConnectionClosed(1006, "receive failed: %s" % e)
        if not data:
            self.abort()
            raise ConnectionClosed(self.close_code or 1006, self.close_reason or "connection closed by the server")
        self._buf += data
        self.last_rx = time.time()
        return True

    def _parse_frame(self):
        buf = self._buf
        if len(buf) < 2:
            return None
        b0, b1 = buf[0], buf[1]
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        idx = 2
        if length == 126:
            if len(buf) < 4:
                return None
            length = struct.unpack(">H", bytes(buf[2:4]))[0]
            idx = 4
        elif length == 127:
            if len(buf) < 10:
                return None
            length = struct.unpack(">Q", bytes(buf[2:10]))[0]
            idx = 10
        if b0 & 0x70:
            self._fail(1002, "reserved bits set (no extensions were negotiated)")
        if opcode >= 0x8 and (not fin or length > 125):
            self._fail(1002, "bad control frame")
        if length > self.max_message:
            self._fail(1009, "frame too big")
        key = None
        if masked:
            if len(buf) < idx + 4:
                return None
            key = bytes(buf[idx:idx + 4])
            idx += 4
        if len(buf) < idx + length:
            return None
        payload = bytes(buf[idx:idx + length])
        del buf[:idx + length]
        if key is not None:  # servers must not mask; tolerate it anyway
            payload = mask_payload(key, payload)
        return fin, opcode, payload
