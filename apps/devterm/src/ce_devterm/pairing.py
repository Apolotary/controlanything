"""Device-code pairing over the hub's REST API (urllib, no proxies: the server is on the LAN).

  POST /api/pair/start {name, kind, capabilities} -> {pairingId, code, display, qr, expiresAt, pollSecret, status}
  GET  /api/pair/status?pairingId&pollSecret      -> {status, deviceId?, deviceToken? (once)}

A request from localhost is approved on the spot (the Mac owns the server); anything else waits for an
approver: the Quest looking at the QR, the code typed on the Mac/iPhone, or `y` in the server terminal.
"""
import json
import time

try:
    from urllib.error import HTTPError, URLError
    from urllib.parse import urlencode
    from urllib.request import ProxyHandler, Request, build_opener
except ImportError:  # pragma: no cover
    raise

from . import __version__, proto

PAIRING_TTL_S = 300


class ApiError(Exception):
    def __init__(self, message, status=None, code=None):
        Exception.__init__(self, message)
        self.status = status
        self.code = code


class Unreachable(ApiError):
    pass


class Api(object):
    def __init__(self, base_url, timeout=6.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = build_opener(ProxyHandler({}))

    def _request(self, method, path, body=None, token=None):
        data = None
        headers = {"accept": "application/json", "user-agent": "%s/%s" % (proto.APP_NAME, __version__)}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        if token:
            headers["authorization"] = "Bearer %s" % token
        req = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            resp = self._opener.open(req, timeout=self.timeout)
            raw = resp.read()
            status = resp.getcode()
        except HTTPError as e:
            raw = e.read() if hasattr(e, "read") else b""
            try:
                j = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                j = {}
            raise ApiError(j.get("message") or "HTTP %d" % e.code, e.code, j.get("error"))
        except URLError as e:
            raise Unreachable("cannot reach %s (%s)" % (self.base, getattr(e, "reason", e)))
        except OSError as e:  # timeouts, resets
            raise Unreachable("cannot reach %s (%s)" % (self.base, e))
        try:
            return status, (json.loads(raw.decode("utf-8")) if raw else {})
        except ValueError:
            raise ApiError("server sent something that is not JSON", status)

    def health(self):
        return self._request("GET", "/api/health")[1]

    def me(self, token):
        """The device record for a token, or None if the token is unknown/revoked."""
        try:
            return self._request("GET", "/api/me", token=token)[1]
        except ApiError as e:
            if e.status == 401:
                return None
            raise

    def pair_start(self, name, kind="devterm", capabilities=None):
        caps = list(capabilities or proto.CAPABILITIES)
        body = {"name": name[:120], "kind": kind, "capabilities": caps}
        try:
            return self._request("POST", "/api/pair/start", body)[1]
        except ApiError as e:
            if e.status == 400 and caps != proto.BASE_CAPS:
                body["capabilities"] = list(proto.BASE_CAPS)  # a server whose schema predates printer/local
                return self._request("POST", "/api/pair/start", body)[1]
            raise

    def pair_status(self, pairing_id, poll_secret):
        q = urlencode({"pairingId": pairing_id, "pollSecret": poll_secret})
        return self._request("GET", "/api/pair/status?" + q)[1]


class PairingSession(object):
    """One device-code flow. start() once, then poll() every ~1.5 s until done."""

    def __init__(self, api, name, kind="devterm", capabilities=None, clock=time.time):
        self.api = api
        self.name = name
        self.kind = kind
        self.capabilities = capabilities
        self.clock = clock
        self.status = "idle"  # idle | pending | approved | denied | expired | error
        self.error = None
        self.pairing_id = None
        self.poll_secret = None
        self.code = None
        self.display = None
        self.qr = None
        self.expires_at = None
        self.started_at = None
        self.device_id = None
        self.token = None
        self.reason = None

    @property
    def done(self):
        return self.status in ("approved", "denied", "expired")

    def start(self):
        r = self.api.pair_start(self.name, self.kind, self.capabilities)
        self.started_at = self.clock()
        self.pairing_id = r.get("pairingId")
        self.poll_secret = r.get("pollSecret")
        self.code = r.get("code")
        self.display = r.get("display") or self.code
        self.qr = r.get("qr")
        self.expires_at = r.get("expiresAt")
        self.status = r.get("status") or "pending"
        self._take_token(r)
        return self

    def poll(self):
        if self.done or not self.pairing_id:
            return self.status
        try:
            r = self.api.pair_status(self.pairing_id, self.poll_secret)
        except ApiError as e:
            if e.status in (403, 404, 410):
                self.status, self.reason = "expired", e.code or "gone"
                return self.status
            raise
        self.status = r.get("status") or self.status
        self.reason = r.get("reason")
        self._take_token(r)
        if self.status == "approved" and not self.token:
            # approved, but the one-time token was already handed out (another poller?): start over
            self.status, self.reason = "expired", "token already taken"
        return self.status

    def _take_token(self, r):
        if r.get("deviceToken") and r.get("deviceId"):
            self.token = r["deviceToken"]
            self.device_id = r["deviceId"]
            self.status = "approved"

    def seconds_left(self):
        now = self.clock()
        if self.expires_at:
            left = self.expires_at / 1000.0 - now
            if 0 <= left <= 3600:
                return left
        if self.started_at:
            return max(0.0, self.started_at + PAIRING_TTL_S - now)
        return 0.0
