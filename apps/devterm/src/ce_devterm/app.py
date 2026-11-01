"""The app controller: pairing, the hub link, the local executor and every user action.

Background threads (pairing, link, executor) only post events to `self.events`; `pump()` applies them
to the AppState on the UI thread, so the screens never race the network.
"""
import queue
import threading
import time

from . import __version__, config, printer as printer_mod, proto, receipt
from .executor import Executor
from .link import Link
from .model import AppState
from .pairing import Api, ApiError, PairingSession
from .sound import Sound
from .surface import Item, Surface, event_value
from .tape import Row

MOVE_INTERVAL = 0.1  # control.event 'move' at most 10 per second
END_AFTER = 0.4  # 'end' after this long without a key press


class Options(object):
    def __init__(self, server=None, name=None, demo=False, printer="auto", print_dir=None, open_receipts=False,
                 ticket="auto", identity_path=None, role=None, density=None, self_test=True, qr="short"):
        self.server = server  # ServerAddress or None
        self.name = name
        self.demo = demo
        self.printer = printer
        self.print_dir = print_dir
        self.open_receipts = open_receipts
        self.ticket = ticket  # auto (paper only) | always | never
        self.identity_path = identity_path or config.identity_path(demo)
        self.role = role
        self.density = density
        self.self_test = self_test
        self.qr = qr  # short = "CE1:<code>" (far-readable), url = the server's pairing link


def self_test_surface(device_name):
    """The DevTerm's own hacks, hand-written (not generated): they run locally without the server."""
    specs = [
        ("local.print", "Print receipt", "a test receipt · no undo", True,
         {"kind": "local", "op": "print", "arg": {"title": "RECEIPT", "device": device_name, "hack": "Print receipt",
                                                  "lines": ["built-in self-test", "the camera watching the paper is the proof"],
                                                  "models": ["(none: hand-written hack)"]}}),
        ("local.beep", "Beep pattern", "3 pips · 2 kHz · 1 Hz", False,
         {"kind": "local", "op": "beep", "arg": {"freq": 2000, "count": 3, "ms": 120}}),
        ("local.say", "Say line", "speaks one line", False, {"kind": "local", "op": "say", "arg": "link verified"}),
        ("local.flash", "Flash terminal", "inverts the screen once", False, {"kind": "local", "op": "screen", "arg": "invert"}),
        ("local.word", "Show word", "one big word", False, {"kind": "local", "op": "screen", "arg": {"text": "HELLO", "ms": 3000}}),
    ]
    items = []
    for id_, label, detail, irreversible, op in specs:
        it = Item(id_, "action", label, detail=detail, confirm=irreversible, irreversible=irreversible, channel="local")
        it.local_op = op
        items.append(it)
    s = Surface("local", "%s · built-in" % device_name, device_name=device_name, items=items, source="hand", channel="local")
    s.local = True
    return s


class App(object):
    def __init__(self, opts):
        self.opts = opts
        self.identity = config.Identity.load(opts.identity_path)
        self.server = opts.server
        if self.server is None and self.identity.server:
            try:
                self.server = config.parse_server(self.identity.server)
            except ValueError:
                self.server = None
        name = opts.name or (self.identity.name if self.identity.paired else None) or config.default_device_name(opts.demo)
        self.state = AppState(name=name, server=self.server.display if self.server else "", demo=opts.demo)
        self.events = queue.Queue()
        self.printer = printer_mod.make_printer(opts.printer, out_dir=opts.print_dir, density=opts.density,
                                                open_viewer=opts.open_receipts)
        self.sound = Sound()
        self.executor = Executor(self.printer, self.sound, send=self.send, ui=self._ui, device_id=self.my_device_id,
                                 device_name=name)
        self.link = None
        self.pair_session = None
        self.pair_info = {"state": "idle", "detail": ""}
        self.phase = "setup"
        self.quit = False
        self.bells = 0
        self.ticket_printed = False
        self._adjust = {}
        self._pair_gen = 0
        if opts.self_test:
            self.state.add_surface(self_test_surface(name))

    # ---- identity / lifecycle ------------------------------------------------------------------

    def my_device_id(self):
        return self.state.device_id or self.identity.device_id

    def start(self):
        if self.server is None:
            self.phase = "setup"
            return
        self.state.server = self.server.display
        if self.identity.paired:
            self.phase = "run"
            self.start_link()
        else:
            self.begin_pairing()

    def set_server(self, text):
        self.server = config.parse_server(text)
        self.state.server = self.server.display
        self.start()

    def stop(self):
        self.quit = True
        self._pair_gen += 1
        self.stop_link()
        self.sound.stop()

    # ---- pairing -------------------------------------------------------------------------------

    def begin_pairing(self):
        self.stop_link()
        self.phase = "pair"
        self.pair_session = None
        self.pair_info = {"state": "starting", "detail": "asking %s for a code" % self.server.display}
        self._pair_gen += 1
        gen = self._pair_gen
        threading.Thread(target=self._pair_worker, args=(gen,), name="ce-pair", daemon=True).start()

    def _pair_worker(self, gen):
        api = Api(self.server.http)
        delay = 2.0
        while not self.quit and gen == self._pair_gen:
            sess = PairingSession(api, self.state.name, "devterm", proto.CAPABILITIES)
            try:
                sess.start()
            except ApiError as e:
                self._post("pair", {"state": "error", "detail": str(e), "retryIn": delay})
                time.sleep(delay)
                delay = min(10.0, delay * 1.5)
                continue
            delay = 2.0
            self._post("pair", {"state": sess.status, "session": sess})
            if sess.status == "approved":
                self._post("paired", sess)
                return
            if self._want_ticket():
                self.print_ticket(sess)
            while not self.quit and gen == self._pair_gen and not sess.done:
                time.sleep(1.5)
                if gen != self._pair_gen:
                    return
                try:
                    sess.poll()
                except ApiError as e:
                    self._post("pair", {"state": "pending", "session": sess, "detail": str(e)})
                    continue
                if sess.status == "pending" and sess.seconds_left() <= 0:
                    sess.status = "expired"
                self._post("pair", {"state": sess.status, "session": sess})
            if gen != self._pair_gen or self.quit:
                return
            if sess.status == "approved":
                self._post("paired", sess)
                return
            if sess.status == "denied":
                self._post("pair", {"state": "denied", "session": sess, "detail": "denied on the approver; new code in 10 s"})
                time.sleep(10)
            # expired or denied: loop for a fresh code (the ticket is not reprinted automatically)

    def _want_ticket(self):
        if self.ticket_printed or self.opts.ticket == "never":
            return False
        if self.opts.ticket == "always":
            return True
        return isinstance(self.printer, printer_mod.DevTermPrinter)  # paper only; press p for a preview

    def print_ticket(self, sess=None):
        sess = sess or self.pair_session
        if sess is None or not sess.display:
            return
        self.ticket_printed = True

        def job():
            r = receipt.pairing_ticket(sess.display, sess.qr_payload(self.opts.qr), self.state.name,
                                       self.server.display if self.server else "", sess.expires_at)
            try:
                res = self.printer.print_receipt(r)
            except printer_mod.PrinterError as e:
                self._post("ui", ("ticket", {"ok": False, "detail": str(e)}))
                return
            self._post("ui", ("ticket", {"ok": True, "detail": res.detail, "path": res.path, "lines": r.preview()}))

        threading.Thread(target=job, name="ce-ticket", daemon=True).start()

    def _on_paired(self, sess):
        self.identity.server = self.server.http
        self.identity.device_id = sess.device_id
        self.identity.token = sess.token
        self.identity.name = self.state.name
        self.identity.paired_at = config.now_ms()
        try:
            self.identity.save(self.opts.identity_path)
            where = "token saved"
        except OSError as e:
            where = "token NOT saved: %s" % e
        self.state.add_row(Row("LINK", self.state.name, "paired with %s" % self.server.display, "paired", where))
        self.state.say("LINK GRANTED · %s" % self.state.name)
        self.phase = "run"
        self.start_link()

    def forget_pairing(self):
        self.identity.forget()
        self.ticket_printed = False
        self.begin_pairing()

    # ---- the hub link --------------------------------------------------------------------------

    def start_link(self):
        self.stop_link()
        self.link = Link(self.server.ws, self.identity.token, self._on_link_event, capabilities=proto.CAPABILITIES,
                         app="%s@%s" % (proto.APP_NAME, __version__), role=self.opts.role)
        self.link.start()

    def stop_link(self):
        link, self.link = self.link, None
        if link is not None:
            link.stop()

    def _on_link_event(self, kind, data):
        """Runs on the link thread: exec.command and panic go straight to the executor."""
        if kind == "message":
            t = data.get("type")
            if t == "panic":
                self.executor.panic()
            if self.executor.submit(data):
                return
        self.events.put((kind, data))

    def _ui(self, kind, data):
        self.events.put(("ui", (kind, data)))

    def _post(self, kind, data):
        self.events.put((kind, data))

    def send(self, type_, payload, to=None, keep=False):
        link = self.link
        if link is None:
            return False
        return link.send(type_, payload, to=to, keep=keep)

    @property
    def online(self):
        return self.link is not None and self.link.online

    # ---- event pump (UI thread) ------------------------------------------------------------------

    def pump(self, limit=500):
        n = 0
        while n < limit:
            try:
                kind, data = self.events.get_nowait()
            except queue.Empty:
                break
            n += 1
            if kind == "status":
                self.state.on_status(data)
                if data.get("state") == "unauthorized" and self.phase == "run":
                    self.state.add_row(Row("LINK", self.state.name, "token rejected", "unpaired", data.get("detail", "")[:40]))
                    self.forget_pairing()
            elif kind == "message":
                self.state.apply(data)
            elif kind == "ui":
                sub, d = data
                if sub == "exec":
                    self.state.on_exec(d)
                elif sub == "screen":
                    self.state.on_effect(d)
                elif sub == "preview":
                    self.state.preview = d
                    self.state.say("no paper here: preview saved to %s" % d.get("path"), 6)
                elif sub == "bell":
                    self.bells += int(d.get("count") or 1)
                elif sub == "ticket":
                    if d.get("ok"):
                        if d.get("path"):
                            self.state.preview = {"title": "link-request", "lines": d.get("lines") or [], "path": d.get("path")}
                        self.state.say("LINK REQUEST ticket: %s" % d.get("detail"), 6)
                    else:
                        self.state.say("ticket not printed: %s" % d.get("detail"), 6)
            elif kind == "pair":
                self.pair_info = data
                if data.get("session") is not None:
                    self.pair_session = data["session"]
                self.state.touch()
            elif kind == "paired":
                self._on_paired(data)
        self.tick()
        return n

    # ---- user actions --------------------------------------------------------------------------

    def fire(self, surf, item):
        """Upload a hack / press a trigger: the human confirmation the rules ask for is this key press."""
        if surf.local:
            self.executor.run_local(item.local_op, item.label)
            return True, "%s: running on this DevTerm" % item.label
        if item.kind == "daemon":
            return self.command("%s %s" % ("pause" if item.status == "running" else "start", item.label), surf)
        if not item.operable:
            return False, "%s is disarmed: %s" % (item.label, item.reason or "waiting for verification on the real device")
        if not self.online:
            return False, "offline: nothing was sent"
        value = event_value(item)
        if not self.send("control.event", proto.control_event(item.id, value, spec_id=surf.spec_id, phase="end")):
            return False, "offline: nothing was sent"
        shown = item.value_text() if item.kind != "action" else ""
        self.state.add_row(Row("SENT", surf.device_name, item.label, "requested", shown, None, kind="info"))
        return True, "%s: sent, awaiting evidence" % item.label

    def adjust(self, surf, item, direction, coarse=False):
        if surf.local or item.kind in ("action", "daemon"):
            return False, ""
        if not item.operable:
            return False, "%s is disarmed: %s" % (item.label, item.reason or "waiting for verification")
        new = item.nudge(direction, coarse)
        if item.kind == "pads":
            return True, ""
        if new == item.value and item.kind != "toggle":
            return True, ""
        item.value = new
        self.state.touch()
        if not self.online:
            return False, "offline: the value changed here only"
        key = (surf.spec_id, item.id)
        now = time.time()
        if item.kind == "toggle":
            self.send("control.event", proto.control_event(item.id, event_value(item), spec_id=surf.spec_id, phase="end"))
            self.state.add_row(Row("SENT", surf.device_name, item.label, "requested", item.value_text()))
            self._adjust.pop(key, None)
            return True, ""
        st = self._adjust.get(key)
        if st is None:
            st = {"started": False, "last_sent": 0.0}
            self._adjust[key] = st
        st.update(last_key=now, surf=surf, item=item)
        if now - st["last_sent"] >= MOVE_INTERVAL:
            self._send_value(st, "move" if st["started"] else "start")
        else:
            st["dirty"] = True
        return True, ""

    def _send_value(self, st, phase):
        item, surf = st["item"], st["surf"]
        self.send("control.event", proto.control_event(item.id, event_value(item), spec_id=surf.spec_id, phase=phase))
        st["started"] = True
        st["last_sent"] = time.time()
        st["dirty"] = False

    def tick(self):
        now = time.time()
        for key, st in list(self._adjust.items()):
            if st.get("dirty") and now - st["last_sent"] >= MOVE_INTERVAL:
                self._send_value(st, "move")
            if now - st["last_key"] >= END_AFTER:
                self._send_value(st, "end")
                item, surf = st["item"], st["surf"]
                self.state.add_row(Row("SENT", surf.device_name, item.label, "requested", item.value_text()))
                del self._adjust[key]

    def command(self, text, surf=None):
        """A typed command, handled by the server like a final voice transcript ("undo", "make a party mode")."""
        text = " ".join((text or "").split())[:500]
        if not text:
            return False, ""
        if not self.online:
            return False, "offline: command not sent"
        p = {"text": text, "final": True, "utteranceId": proto.new_id("u")}
        if surf is not None and not surf.local:
            if surf.card_id:
                p["cardId"] = surf.card_id
            p["specId"] = surf.spec_id
        self.send("voice.text", p, to=proto.SERVER)
        self.state.add_row(Row("TYPED", surf.device_name if surf else "", '"%s"' % text[:40], "requested", "", key="vt:" + p["utteranceId"]))
        return True, "sent: %s" % text

    def undo(self, surf=None):
        return self.command("undo", surf)

    def panic(self):
        dropped = self.executor.panic()
        sent = self.send("panic", {"reason": "panic key on %s" % self.state.name}, to=proto.SERVER)
        self.state.add_row(Row("PANIC", self.state.name, "stop everything", "sent" if sent else "local only",
                               "%d jobs dropped" % dropped if dropped else ""))
        return True, "PANIC sent: stop everything" if sent else "offline: stopped local jobs only"
