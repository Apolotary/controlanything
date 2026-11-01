"""Where the device token lives, and how a server address is normalised.

~/.config/controleverything/device.json (XDG_CONFIG_HOME respected), mode 0600:
  {"version": 1, "server": "http://192.168.1.14:8787", "deviceId": "...", "deviceToken": "...",
   "name": "DevTerm", "kind": "devterm", "pairedAt": 1730500000000}
"""
import json
import os
import socket
import time

try:
    from urllib.parse import urlsplit
except ImportError:  # pragma: no cover
    from urlparse import urlsplit  # type: ignore

DEFAULT_PORT = 8787
APP_DIR = "controleverything"


def config_dir():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, APP_DIR)


def identity_path(demo=False):
    return os.path.join(config_dir(), "device-demo.json" if demo else "device.json")


class ServerAddress(object):
    """http://host:port for the REST API and ws://host:port/ws for the hub."""

    def __init__(self, host, port=DEFAULT_PORT):
        self.host = host
        self.port = int(port)

    @property
    def http(self):
        return "http://%s:%d" % (self._host_for_url(), self.port)

    @property
    def ws(self):
        return "ws://%s:%d/ws" % (self._host_for_url(), self.port)

    @property
    def display(self):
        return "%s:%d" % (self._host_for_url(), self.port)

    def _host_for_url(self):
        return "[%s]" % self.host if ":" in self.host and not self.host.startswith("[") else self.host

    def is_loopback(self):
        h = self.host.strip("[]").lower()
        return h in ("localhost", "::1") or h.startswith("127.")

    def __eq__(self, other):
        return isinstance(other, ServerAddress) and (self.host, self.port) == (other.host, other.port)

    def __repr__(self):
        return "ServerAddress(%r, %d)" % (self.host, self.port)


def parse_server(text):
    """Accept "192.168.1.14", "192.168.1.14:8787", "http://mac.local:8787/", "ws://host:8787/ws"."""
    s = (text or "").strip()
    if not s:
        raise ValueError("empty server address")
    if "://" not in s:
        s = "http://" + s
    parts = urlsplit(s)
    if parts.scheme not in ("http", "ws"):
        raise ValueError("use plain http/ws on port %d (the DevTerm client does not speak TLS): %r" % (DEFAULT_PORT, text))
    host = parts.hostname
    if not host:
        raise ValueError("no host in %r" % text)
    try:
        port = parts.port or DEFAULT_PORT
    except ValueError:
        raise ValueError("bad port in %r" % text)
    return ServerAddress(host, port)


class Identity(object):
    """A paired device: its token and the server it was paired with."""

    def __init__(self, server=None, device_id=None, token=None, name="DevTerm", kind="devterm", paired_at=None, path=None):
        self.server = server
        self.device_id = device_id
        self.token = token
        self.name = name
        self.kind = kind
        self.paired_at = paired_at
        self.path = path

    @property
    def paired(self):
        return bool(self.token and self.device_id)

    def to_json(self):
        return {
            "version": 1,
            "server": self.server,
            "deviceId": self.device_id,
            "deviceToken": self.token,
            "name": self.name,
            "kind": self.kind,
            "pairedAt": self.paired_at,
        }

    @classmethod
    def load(cls, path):
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except (IOError, OSError, ValueError):
            return cls(path=path)
        if not isinstance(data, dict):
            return cls(path=path)
        return cls(
            server=data.get("server"),
            device_id=data.get("deviceId"),
            token=data.get("deviceToken"),
            name=data.get("name") or "DevTerm",
            kind=data.get("kind") or "devterm",
            paired_at=data.get("pairedAt"),
            path=path,
        )

    def save(self, path=None):
        """Atomic write, 0600 (the token is a credential)."""
        path = path or self.path
        if not path:
            raise ValueError("no identity path")
        d = os.path.dirname(path)
        if d and not os.path.isdir(d):
            os.makedirs(d, mode=0o700)
        tmp = "%s.%d.tmp" % (path, os.getpid())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(self.to_json(), f, indent=2, sort_keys=True)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self.path = path

    def forget(self):
        """Drop the token (keep the server address so re-pairing is one step)."""
        self.token = None
        self.device_id = None
        self.paired_at = None
        if self.path:
            self.save()


def default_device_name(demo=False):
    if demo:
        return "DevTerm (demo)"
    host = socket.gethostname().split(".")[0] or "devterm"
    return "DevTerm" if host.lower() in ("devterm", "clockworkpi", "raspberrypi") else "DevTerm %s" % host[:24]


def now_ms():
    return int(time.time() * 1000)
