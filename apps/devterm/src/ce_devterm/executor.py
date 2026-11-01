"""The local executor: runs `exec.command` LocalOps addressed to this device and answers `exec.ack`.

  print   a 32-column receipt (text/QR) on the thermal printer; on a Mac, a PNG + text preview
  beep    pips from the speaker ({freq, count, ms}, <= 3 Hz)
  say     speech (espeak on the DevTerm, say on a Mac)
  screen  "invert" (one inversion, no flashing), "#rrggbb" wash, "off", or {text} big on the screen
  volume  ALSA master volume 0-100 (Linux only)

Acks report when the bytes/sound went out ("sent"), never that the effect happened: only an oracle
(camera on the paper, mic on the beep) may say that.
"""
import queue
import sys
import threading
import time

from . import printer as printer_mod
from . import proto, receipt

EXEC_TYPES = ("exec.command", "x.exec.command")
MIN_INTERVAL = {"beep": 1.0 / 3, "screen": 1.0 / 3}


class ExecError(Exception):
    def __init__(self, message, code="device_error"):
        Exception.__init__(self, message)
        self.code = code


def describe_op(op):
    if not isinstance(op, dict):
        return "?"
    name = op.get("op") or op.get("kind") or "?"
    arg = op.get("arg")
    if isinstance(arg, dict):
        arg = arg.get("title") or arg.get("text") or ""
    if isinstance(arg, (str, int, float)) and not isinstance(arg, bool) and str(arg):
        return "%s %s" % (name, str(arg)[:24])
    return name


class Executor(object):
    def __init__(self, printer, sound, send, ui=None, device_id=lambda: None, device_name="DevTerm", platform=None):
        self.printer = printer
        self.sound = sound
        self.send = send  # send(type, payload, to=..., keep=...) -> bool
        self.ui = ui or (lambda kind, data: None)
        self.device_id = device_id
        self.device_name = device_name
        self.platform = platform or sys.platform
        self.q = queue.Queue(maxsize=16)
        self._last = {}
        self._thread = threading.Thread(target=self._worker, name="ce-exec", daemon=True)
        self._thread.start()

    # ---- intake -----------------------------------------------------------------------------------

    def accepts(self, m):
        if m.get("type") not in EXEC_TYPES:
            return False
        me = self.device_id()
        p = m.get("payload") or {}
        target = p.get("executorDeviceId") or m.get("to")
        return bool(me) and target == me

    def submit(self, m):
        """Queue an exec.command for this device. Returns False if it is not ours."""
        if not self.accepts(m):
            return False
        p = m.get("payload") or {}
        try:
            self.q.put_nowait((m, time.time()))
        except queue.Full:
            self._ack(m, False, time.time(), "executor busy (16 jobs queued)", "rate_limited", 0)
            return True
        self.ui("exec", {"execId": p.get("execId"), "op": describe_op(p.get("op")), "state": "requested", "measure": ""})
        return True

    def run_local(self, op, label=""):
        """Run a built-in self-test hack (no server, no ack): same handlers, same printer."""
        fake = {"type": "local", "payload": {"execId": proto.new_id("local"), "op": op}}
        self.q.put_nowait((fake, time.time()))
        self.ui("exec", {"execId": fake["payload"]["execId"], "op": label or describe_op(op), "state": "requested", "measure": ""})

    def panic(self):
        """Stop sounds and drop queued jobs (paper already printing cannot be stopped)."""
        dropped = 0
        while True:
            try:
                m, _ = self.q.get_nowait()
            except queue.Empty:
                break
            dropped += 1
            if m.get("type") in EXEC_TYPES:
                self._ack(m, False, time.time(), "dropped by panic", "refused", 0)
        self.sound.stop()
        self.ui("screen", {"reset": True})
        return dropped

    # ---- worker -----------------------------------------------------------------------------------

    def _worker(self):
        while True:
            m, received = self.q.get()
            try:
                self._handle(m, received)
            except Exception as e:  # keep the worker alive whatever a handler does
                self._finish(m, False, time.time(), "internal error: %s" % e, "device_error", received)

    def _handle(self, m, received):
        p = m.get("payload") or {}
        op = p.get("op") or {}
        dry = bool(p.get("dryRun"))
        if not isinstance(op, dict) or op.get("kind") != "local":
            kind = op.get("kind") if isinstance(op, dict) else "?"
            self._finish(m, False, time.time(), "the DevTerm executes local ops only (got %s)" % kind, "unsupported", received)
            return
        name = op.get("op")
        handler = getattr(self, "_op_" + str(name), None)
        if handler is None:
            self._finish(m, False, time.time(), "%s is not available on the DevTerm" % name, "unsupported", received)
            return
        gap = MIN_INTERVAL.get(name)
        if gap and not dry:
            wait = self._last.get(name, 0) + gap - time.time()
            if wait > 0:
                time.sleep(min(wait, gap))
        try:
            sent_at, detail = handler(op.get("arg"), dry)
        except ExecError as e:
            self._finish(m, False, time.time(), str(e), e.code, received)
            return
        except printer_mod.PrinterError as e:
            self._finish(m, False, time.time(), str(e), e.code, received)
            return
        self._last[name] = time.time()
        self._finish(m, True, sent_at, detail, None, received)

    def _finish(self, m, ok, sent_at, detail, error, received):
        p = m.get("payload") or {}
        if m.get("type") in EXEC_TYPES:
            self._ack(m, ok, sent_at, detail, error, (sent_at - received) * 1000.0)
        self.ui("exec", {"execId": p.get("execId"), "op": describe_op(p.get("op")), "state": "sent" if ok else "failed",
                         "measure": (detail or "")[:60], "ok": ok, "error": error})

    def _ack(self, m, ok, sent_at, detail, error, latency_ms):
        p = m.get("payload") or {}
        if not p.get("execId"):
            return
        ack_type = "exec.ack" if m.get("type") == "exec.command" else "x.exec.ack"
        payload = proto.exec_ack(p["execId"], ok, sent_at * 1000.0, detail=detail, error=error, latency_ms=latency_ms)
        self.send(ack_type, payload, to=proto.SERVER, keep=True)

    # ---- ops --------------------------------------------------------------------------------------

    def _op_print(self, arg, dry):
        r = receipt.from_print_arg(arg, device_name=self.device_name)
        if dry:
            bm = r.bitmap()
            return time.time(), "dry run: receipt of %d dot rows ready (%s)" % (bm.height, self.printer.describe())
        res = self.printer.print_receipt(r)
        if res.path:
            self.ui("preview", {"title": r.tag, "lines": r.preview(), "path": res.path})
        return res.sent_at, res.detail

    def _op_beep(self, arg, dry):
        freq, ms, count = 2000.0, 120, 1
        if isinstance(arg, bool):
            pass
        elif isinstance(arg, (int, float)):
            freq = float(arg)
        elif isinstance(arg, dict):
            freq = _num(arg.get("freq"), freq)
            ms = int(_num(arg.get("ms"), ms))
            count = int(_num(arg.get("count"), count))
        elif isinstance(arg, str) and arg.strip():
            try:
                freq = float(arg)
            except ValueError:
                raise ExecError("beep wants a frequency or {freq, count, ms}, got %r" % arg[:40], "bad_args")
        if not 100 <= freq <= 8000:
            raise ExecError("beep frequency %d Hz is outside 100-8000 Hz" % freq, "bad_args")
        count = max(1, min(8, count))
        ms = max(20, min(1000, ms))
        if dry:
            return time.time(), "dry run: %d x %d Hz" % (count, freq)
        sent_at = time.time()
        ok, detail = self.sound.beep(freq, ms, count, interval_ms=1000)
        if not ok and getattr(self.sound, "mute", False):
            raise ExecError(detail, "refused")  # --mute: no sound and no terminal bell either
        self.ui("bell", {"count": count})
        if not ok:
            detail += "; rang the terminal bell instead"
        return sent_at, detail

    def _op_say(self, arg, dry):
        text = arg.get("text") if isinstance(arg, dict) else arg
        if not isinstance(text, str) or not text.strip():
            raise ExecError("say wants text", "bad_args")
        text = " ".join(text.split())[:300]
        if dry:
            return time.time(), "dry run: would say %d characters" % len(text)
        sent_at = time.time()
        ok, detail = self.sound.say(text)
        self.ui("screen", {"banner": text[:40], "ms": 3000})
        if not ok:
            raise ExecError(detail + "; showed the text on screen instead", "unsupported")
        return sent_at, detail

    def _op_screen(self, arg, dry):
        effect = {}
        if isinstance(arg, dict):
            if arg.get("text"):
                effect = {"banner": str(arg.get("text"))[:24], "ms": int(_num(arg.get("ms"), 4000))}
            elif arg.get("color"):
                effect = {"wash": str(arg.get("color")), "ms": int(_num(arg.get("ms"), 3000))}
            elif arg.get("mode") in ("invert", "flash"):
                effect = {"invert": True, "ms": int(_num(arg.get("ms"), 1500))}
        elif isinstance(arg, str):
            a = arg.strip()
            if a in ("invert", "flash"):
                effect = {"invert": True, "ms": 1500}
            elif a == "off":
                effect = {"reset": True}
            elif a.startswith("#") and len(a) == 7:
                effect = {"wash": a, "ms": 3000}
            elif a:
                effect = {"banner": a[:24], "ms": 4000}
        if not effect:
            raise ExecError("screen wants invert | off | #rrggbb | {text} | {color}", "bad_args")
        if dry:
            return time.time(), "dry run: screen %s" % ", ".join(sorted(effect))
        effect["ms"] = max(300, min(10000, effect.get("ms", 1500)))
        sent_at = time.time()
        self.ui("screen", effect)
        note = " (steady: this screen never flashes)" if isinstance(arg, dict) and arg.get("mode") in ("flash", "pulse") else ""
        return sent_at, "screen %s%s" % (", ".join(k for k in sorted(effect) if k != "ms"), note)

    def _op_volume(self, arg, dry):
        import shutil
        import subprocess
        if not self.platform.startswith("linux") or not shutil.which("amixer"):
            raise ExecError("volume is only available on the DevTerm (ALSA amixer)", "unsupported")
        level = _num(arg, None)
        if level is None or not 0 <= level <= 100:
            raise ExecError("volume wants 0-100", "bad_args")
        if dry:
            return time.time(), "dry run: volume %d %%" % level
        sent_at = time.time()
        for control in ("Master", "PCM", "Speaker"):
            r = subprocess.run(["amixer", "-q", "-M", "sset", control, "%d%%" % level], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode == 0:
                return sent_at, "volume %d %% (%s)" % (level, control)
        raise ExecError("amixer found no Master/PCM/Speaker control", "device_error")


def _num(v, default):
    if isinstance(v, bool):
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default
