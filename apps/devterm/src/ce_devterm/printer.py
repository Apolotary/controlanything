"""Printer backends: the DevTerm thermal printer, and a file preview for machines without one (a Mac).

DevTerm path: ClockworkPi's daemon reads a socat pty at /tmp/DEVTERM_PRINTER_IN (raw mode, so binary
raster data passes untouched) and understands a small ESC/POS subset. We only send commands its parser
knows (ESC @, ESC a, ESC J, ESC !, DC2 #, GS v 0), because an unknown escape leaves it waiting for up to
10 bytes. Raster rules from its source: GS v 0 width is in bytes and must be <= 48 (384 dots), and the
image size must stay below 64 KiB (16-bit counters), so receipts go out in strips of <= 600 rows.
"""
import errno
import os
import select
import shutil
import subprocess
import sys
import time

from . import raster

DEVTERM_PRINTER = "/tmp/DEVTERM_PRINTER_IN"
DAEMON_CONFIG = "/usr/local/etc/devterm-printer"
BATTERY = "/sys/class/power_supply/axp20x-battery/capacity"
LOCK_FILE = "/tmp/ce-devterm-printer.lock"

ESC = b"\x1b"
GS = b"\x1d"
DC2 = b"\x12"
ROW_BYTES = raster.PAPER_DOTS // 8  # 48
MAX_STRIP_ROWS = 600  # 600 * 48 = 28.8 KB per GS v 0 image


class PrinterError(RuntimeError):
    def __init__(self, message, code="device_error"):
        RuntimeError.__init__(self, message)
        self.code = code


class PrintResult(object):
    def __init__(self, backend, detail, rows=0, path=None, sent_at=None):
        self.backend = backend
        self.detail = detail
        self.rows = rows
        self.path = path
        self.sent_at = sent_at if sent_at is not None else time.time()


# ---- ESC/POS encoding -----------------------------------------------------------------------------

def raster_command(bm):
    """GS v 0 commands for a bitmap, split into strips the daemon accepts."""
    rows = bm.pack_rows()
    out = bytearray()
    for start in range(0, len(rows), MAX_STRIP_ROWS):
        strip = rows[start:start + MAX_STRIP_ROWS]
        h = len(strip)
        out += GS + b"v0\x00" + bytes((ROW_BYTES & 0xFF, ROW_BYTES >> 8, h & 0xFF, h >> 8))
        for r in strip:
            out += r[:ROW_BYTES].ljust(ROW_BYTES, b"\x00")
    return bytes(out)


def _text_command(text, align):
    """One Unicode line through the daemon's TrueType font (only used when a TTF is configured)."""
    a = {"left": 0, "center": 1, "right": 2}.get(align, 0)
    safe = "".join(ch for ch in text if ord(ch) >= 32 and ch != "\x7f")
    return ESC + b"!\x01" + ESC + b"a" + bytes((a,)) + safe.encode("utf-8", "replace") + b"\n" + ESC + b"!\x00" + ESC + b"a\x00"


def encode_job(segments, density=None, feed_dots=120):
    """Receipt segments -> the byte stream for /tmp/DEVTERM_PRINTER_IN."""
    out = bytearray(ESC + b"@")  # reset (also ASCII mode, left aligned)
    if density is not None:
        out += DC2 + b"#" + bytes((max(0, min(15, int(density))),))
    out += ESC + b"a\x00"
    for seg in segments:
        if seg[0] == "raster":
            out += raster_command(seg[1])
        elif seg[0] == "text":
            out += _text_command(seg[1], seg[2] if len(seg) > 2 else "left")
    while feed_dots > 0:  # feed past the tear bar; ESC J takes at most 255 dots
        n = min(255, feed_dots)
        out += ESC + b"J" + bytes((n,))
        feed_dots -= n
    return bytes(out)


def segment_rows(segments):
    return sum(s[1].height for s in segments if s[0] == "raster")


# ---- probes -----------------------------------------------------------------------------------------

def unicode_font_configured(config_path=DAEMON_CONFIG):
    """True when the daemon has a usable TTF= font (needed for Japanese labels)."""
    try:
        with open(config_path, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("TTF="):
                    path = line.split("=", 1)[1].strip().strip("'\"")
                    if not os.path.isabs(path):
                        path = os.path.join(os.path.dirname(config_path), path)
                    return os.path.isfile(path)
    except (IOError, OSError):
        return False
    return False


def battery_percent(path=BATTERY):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (IOError, OSError, ValueError):
        return None


# ---- backends ---------------------------------------------------------------------------------------

class DevTermPrinter(object):
    """Writes ESC/POS to ClockworkPi's printer daemon."""

    name = "devterm"

    def __init__(self, path=DEVTERM_PRINTER, density=None, feed_dots=120, lock_file=LOCK_FILE, timeout=30.0,
                 unicode_config=DAEMON_CONFIG):
        self.path = path
        self.density = density
        self.feed_dots = feed_dots
        self.lock_file = lock_file
        self.timeout = timeout
        self.unicode_config = unicode_config

    def available(self):
        return os.path.exists(self.path) and os.access(self.path, os.W_OK)

    def describe(self):
        if not os.path.exists(self.path):
            return "%s missing (is devterm-socat.service running?)" % self.path
        if not os.access(self.path, os.W_OK):
            return "%s not writable" % self.path
        bat = battery_percent()
        extra = (" · battery %d %%" % bat) if bat is not None else ""
        return "%s%s" % (self.path, extra)

    def unicode_ok(self):
        return unicode_font_configured(self.unicode_config)

    def print_receipt(self, receipt):
        if not self.available():
            raise PrinterError(self.describe(), "no_port")
        bat = battery_percent()
        segments = receipt.segments(unicode_ok=self.unicode_ok())
        payload = encode_job(segments, density=self.density, feed_dots=self.feed_dots)
        sent_at = self._write(payload)
        rows = segment_rows(segments)
        detail = "printed %d dot rows (%d mm)" % (rows, rows // 8)
        if bat is not None and bat <= 14:
            detail += "; battery %d %%: the daemon skips printing at low power" % bat
        return PrintResult(self.name, detail, rows=rows, sent_at=sent_at)

    def _write(self, payload):
        lock = None
        try:
            import fcntl
            lock = os.open(self.lock_file, os.O_CREAT | os.O_RDWR, 0o666)
            deadline = time.time() + self.timeout
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except (IOError, OSError) as e:
                    if e.errno not in (errno.EAGAIN, errno.EACCES):
                        raise
                    if time.time() > deadline:
                        raise PrinterError("another print job is still running", "timeout")
                    time.sleep(0.05)
        except ImportError:
            lock = None
        try:
            flags = os.O_WRONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOCTTY", 0)
            try:
                fd = os.open(self.path, flags)
            except OSError as e:
                raise PrinterError("cannot open %s: %s" % (self.path, e.strerror), "no_port")
            try:
                sent_at = time.time()
                pos = 0
                deadline = time.time() + self.timeout
                while pos < len(payload):
                    try:
                        n = os.write(fd, payload[pos:pos + 4096])
                    except (IOError, OSError) as e:
                        if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                            left = deadline - time.time()
                            if left <= 0:
                                raise PrinterError("printer stopped accepting data after %d of %d bytes" % (pos, len(payload)), "timeout")
                            select.select([], [fd], [], min(0.5, left))
                            continue
                        raise PrinterError("write failed after %d of %d bytes: %s" % (pos, len(payload), e.strerror))
                    if n <= 0:
                        raise PrinterError("printer accepted no data")
                    pos += n
                return sent_at
            finally:
                os.close(fd)
        finally:
            if lock is not None:
                os.close(lock)


def _cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "controleverything", "receipts")


class FilePrinter(object):
    """No paper here: write the receipt as a PNG (exactly the dots the printer would burn) plus a .txt."""

    name = "file"

    def __init__(self, out_dir=None, open_viewer=False):
        self.out_dir = out_dir or _cache_dir()
        self.open_viewer = open_viewer

    def available(self):
        return True

    def describe(self):
        return "preview files in %s" % self.out_dir

    def unicode_ok(self):
        return False

    def print_receipt(self, receipt):
        try:
            os.makedirs(self.out_dir, exist_ok=True)
        except OSError as e:
            raise PrinterError("cannot create %s: %s" % (self.out_dir, e.strerror))
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.join(self.out_dir, "%s-%s" % (stamp, receipt.tag))
        n = 1
        while os.path.exists(base + ".png"):
            n += 1
            base = os.path.join(self.out_dir, "%s-%s-%d" % (stamp, receipt.tag, n))
        bm = receipt.bitmap()
        sent_at = time.time()
        with open(base + ".png", "wb") as f:
            f.write(bm.to_png(scale=2, margin=8))
        with open(base + ".txt", "w") as f:
            f.write(receipt.text())
        if self.open_viewer:
            open_file(base + ".png")
        return PrintResult(self.name, "preview %s.png (%d dot rows)" % (base, bm.height), rows=bm.height, path=base + ".png", sent_at=sent_at)


class NullPrinter(object):
    name = "none"

    def available(self):
        return False

    def describe(self):
        return "printing disabled"

    def unicode_ok(self):
        return False

    def print_receipt(self, receipt):
        raise PrinterError("printing is disabled on this device (--printer none)", "unsupported")


def open_file(path):
    """Show a file with the desktop viewer (macOS `open`, Linux `xdg-open`), without waiting."""
    cmd = None
    if sys.platform == "darwin":
        cmd = ["open", path]
    elif shutil.which("xdg-open") and os.environ.get("DISPLAY"):
        cmd = ["xdg-open", path]
    if cmd:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass


def make_printer(kind="auto", path=DEVTERM_PRINTER, out_dir=None, density=None, open_viewer=False):
    """auto = the DevTerm printer when its input path exists, else file previews."""
    if kind == "none":
        return NullPrinter()
    if kind == "file":
        return FilePrinter(out_dir, open_viewer=open_viewer)
    dev = DevTermPrinter(path=path, density=density)
    if kind == "devterm" or os.path.exists(path):
        return dev
    return FilePrinter(out_dir, open_viewer=open_viewer)
