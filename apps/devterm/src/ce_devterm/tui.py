"""The curses terminal UI.

Screens: SETUP (Mac address) · PAIR (QR + big passcode) · HACKS (your devices: numbered verb list, value
bars) beside the EVIDENCE TAPE on wide screens · TAPE · DAEMONS (automations) · ROOM (links). The status
line shows the link state and the Meta model ids while a call runs.
"""
import curses
import os
import time

from . import bigtext, qr as qrmod
from . import sound as sound_mod
from . import tape as tapemod
from .theme import Theme, unicode_ok

VIEWS = ["hacks", "tape", "daemons", "room"]
VIEW_TITLE = {"hacks": "HACKS", "tape": "TAPE", "daemons": "DAEMONS", "room": "ROOM"}
VIEW_SUB = {"hacks": "your devices", "daemons": "automations"}
VERB_TOKEN = {
    "SENT": "volt", "TYPED": "volt", "EXEC": "volt", "LINK": "cyan", "PING": "cyan", "SCAN": "cyan", "IDENTIFY": "cyan",
    "LEARN": "magenta", "PANIC": "magenta", "LOG": "magenta", "ARM": "magenta", "REFUSED": "bone",
}
WIDE = 112  # columns from which HACKS and the TAPE share the screen


class Tui(object):
    def __init__(self, app, ascii_only=False, mono=False):
        self.app = app
        self.ascii_only = ascii_only
        self.mono = mono
        self.view = "hacks"
        self.surface_idx = 0
        self.item_idx = 0
        self.daemon_idx = 0
        self.tape_scroll = 0  # rows scrolled back from the newest (0 = follow)
        self.prompt = None  # dict(kind, label, text, submit)
        self.overlay = None  # "preview" | "help"
        self.last_draw = 0.0
        self.drawn = -1
        self.seen_bells = 0
        self.seen_preview = None
        self.scr = None
        self.theme = None
        self.g = None

    # ---- run ---------------------------------------------------------------------------------------

    def run(self):
        os.environ.setdefault("ESCDELAY", "25")  # before initscr: the curses escape-delay setter needs Python 3.9
        try:
            import locale
            locale.setlocale(locale.LC_ALL, "")  # ncursesw draws UTF-8 only with the user's locale active
        except Exception:
            pass
        try:
            curses.wrapper(self._main)
        finally:
            self.app.stop()

    def _main(self, scr):
        self.scr = scr
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        scr.keypad(True)
        scr.timeout(100)
        uni = (not self.ascii_only) and unicode_ok()
        self.theme = Theme(mono=self.mono, uni=uni)
        self.g = self.theme.glyphs
        self.app.start()
        if self.app.phase == "setup":
            self._ask_server()
        while not self.app.quit:
            self.app.pump()
            self._keys()
            if self.app.quit:
                break
            now = time.time()
            st = self.app.state
            if st.preview is not None and st.preview is not self.seen_preview:
                self.seen_preview = st.preview
                self.overlay = "preview"
            if self.app.bells > self.seen_bells:
                self.seen_bells = self.app.bells
                if not sound_mod.player_command():
                    curses.beep()
            if st.version != self.drawn or now - self.last_draw > 0.5:
                self.drawn = st.version
                self.last_draw = now
                self.draw()

    # ---- input -------------------------------------------------------------------------------------

    def _keys(self):
        for _ in range(32):
            try:
                k = self.scr.get_wch()
            except curses.error:
                return
            self._key(k)
            self.app.state.touch()
            if self.app.quit:
                return

    def _key(self, k):
        if k == curses.KEY_RESIZE:
            try:
                curses.update_lines_cols()
            except AttributeError:
                pass
            return
        if self.prompt is not None:
            self._prompt_key(k)
            return
        if self.overlay is not None:
            self.overlay = None
            return
        phase = self.app.phase
        if phase == "setup":
            if k in ("q", "Q"):
                self.app.quit = True
            else:
                self._ask_server()
            return
        if phase == "pair":
            self._pair_key(k)
            return
        self._run_key(k)

    def _pair_key(self, k):
        if k in ("q", "Q", "\x1b"):
            self.app.quit = True
        elif k in ("p", "P"):
            self.app.print_ticket()
            self.app.state.say("printing the LINK REQUEST ticket…")
        elif k in ("n", "N"):
            self.app.begin_pairing()
        elif k in ("s", "S"):
            self._ask_server()

    def _run_key(self, k):
        app = self.app
        surf, item = self._current()
        if k in ("q", "Q"):
            app.quit = True
        elif k == "\t":
            self.view = VIEWS[(VIEWS.index(self.view) + 1) % len(VIEWS)]
        elif k == curses.KEY_BTAB:
            self.view = VIEWS[(VIEWS.index(self.view) - 1) % len(VIEWS)]
        elif k in ("h", "t", "d", "r") and not (self.view == "daemons" and k == "d"):
            self.view = {"h": "hacks", "t": "tape", "d": "daemons", "r": "room"}[k]
        elif k == "?":
            self.overlay = "help"
        elif k in (":", "/"):
            self._open_prompt("command", "COMMAND", lambda text: self._flash(app.command(text, self._surface())))
        elif k == "!":
            self._open_prompt("confirm", "PANIC: stop everything in the room? y/n", lambda ans: self._flash(app.panic()))
        elif k == "u":
            self._flash(app.undo(self._surface()))
        elif k == "R":
            if app.link:
                app.link.reconnect_now()
        elif k == "X":
            self._open_prompt("confirm", "Forget this DevTerm's pairing and pair again? y/n", lambda ans: app.forget_pairing())
        elif self.view == "hacks":
            self._hacks_key(k, surf, item)
        elif self.view == "tape":
            self._tape_key(k)
        elif self.view == "daemons":
            self._daemons_key(k)

    def _hacks_key(self, k, surf, item):
        app = self.app
        n = len(surf.hacks) if surf else 0
        if k in (curses.KEY_UP, "k"):
            self.item_idx = max(0, self.item_idx - 1)
        elif k in (curses.KEY_DOWN, "j"):
            self.item_idx = min(max(0, n - 1), self.item_idx + 1)
        elif k in ("[", curses.KEY_PPAGE):
            self.surface_idx = max(0, self.surface_idx - 1)
            self.item_idx = 0
        elif k in ("]", curses.KEY_NPAGE):
            self.surface_idx = min(max(0, len(app.state.surfaces) - 1), self.surface_idx + 1)
            self.item_idx = 0
        elif item is None:
            return
        elif k in (curses.KEY_LEFT, curses.KEY_RIGHT, "-", "+", "=", "_"):
            direction = 1 if k in (curses.KEY_RIGHT, "+", "=") else -1
            coarse = k in ("-", "+", "=", "_")
            ok, msg = app.adjust(surf, item, direction, coarse)
            if msg:
                self._flash((ok, msg))
        elif k in ("\n", "\r", curses.KEY_ENTER, " "):
            self._upload(surf, item)
        elif isinstance(k, str) and k.isdigit() and k != "0":
            i = int(k) - 1
            if i < n:
                self.item_idx = i
                self._upload(surf, surf.hacks[i])

    def _upload(self, surf, item):
        """Enter/digit: the human confirmation. Continuous controls already send while moved; Enter
        re-sends the current value. Paper (irreversible) asks y first."""
        if item.irreversible or item.confirm:
            self._open_prompt("confirm", "%s cannot be undone (paper). Upload? y/n" % item.label,
                              lambda ans: self._flash(self.app.fire(surf, item)))
            return
        self._flash(self.app.fire(surf, item))

    def _tape_key(self, k):
        rows = len(self.app.state.tape)
        if k in (curses.KEY_UP, "k"):
            self.tape_scroll = min(rows, self.tape_scroll + 1)
        elif k in (curses.KEY_DOWN, "j"):
            self.tape_scroll = max(0, self.tape_scroll - 1)
        elif k == curses.KEY_PPAGE:
            self.tape_scroll = min(rows, self.tape_scroll + 10)
        elif k == curses.KEY_NPAGE:
            self.tape_scroll = max(0, self.tape_scroll - 10)
        elif k in (curses.KEY_END, "G"):
            self.tape_scroll = 0

    def _daemons_key(self, k):
        ds = self._daemons()
        if k in (curses.KEY_UP, "k"):
            self.daemon_idx = max(0, self.daemon_idx - 1)
        elif k in (curses.KEY_DOWN, "j"):
            self.daemon_idx = min(max(0, len(ds) - 1), self.daemon_idx + 1)
        elif not ds:
            return
        elif k in ("p", " ", "\n", "\r", curses.KEY_ENTER):
            surf, it = ds[min(self.daemon_idx, len(ds) - 1)]
            verb = "pause" if it.status == "running" else "start"
            self._flash(self.app.command("%s %s" % (verb, it.label), surf))
        elif k in ("K", "x"):
            surf, it = ds[min(self.daemon_idx, len(ds) - 1)]
            self._open_prompt("confirm", "Stop the daemon %s? y/n" % it.label,
                              lambda ans: self._flash(self.app.command("stop %s" % it.label, surf)))

    # ---- prompt --------------------------------------------------------------------------------------

    def _open_prompt(self, kind, label, submit, text=""):
        self.prompt = {"kind": kind, "label": label, "text": text, "submit": submit}

    def _ask_server(self):
        hint = self.app.server.display if self.app.server else ""

        def submit(text):
            try:
                self.app.set_server(text)
            except ValueError as e:
                self.app.state.say(str(e))
                self._ask_server()

        self._open_prompt("server", "MAC ADDRESS (the server, e.g. 192.168.1.14 or 192.168.1.14:8787)", submit, hint)

    def _prompt_key(self, k):
        p = self.prompt
        if p["kind"] == "confirm":
            self.prompt = None
            if k in ("y", "Y"):
                p["submit"]("y")
            else:
                self.app.state.say("cancelled")
            return
        if k == "\x1b":
            self.prompt = None
            if p["kind"] == "server" and self.app.phase == "setup":
                self.app.quit = True
            return
        if k in ("\n", "\r", curses.KEY_ENTER):
            self.prompt = None
            if p["text"].strip():
                p["submit"](p["text"].strip())
            elif p["kind"] == "server":
                self._ask_server()
            return
        if k in (curses.KEY_BACKSPACE, "\x7f", "\b"):
            p["text"] = p["text"][:-1]
        elif k == "\x15":  # ^U
            p["text"] = ""
        elif isinstance(k, str) and k.isprintable() and len(p["text"]) < 300:
            p["text"] += k

    def _flash(self, result):
        ok, msg = result if isinstance(result, tuple) else (True, str(result))
        if msg:
            self.app.state.say(msg)

    # ---- selection helpers -----------------------------------------------------------------------------

    def _surface(self):
        ss = self.app.state.surfaces
        if not ss:
            return None
        self.surface_idx = max(0, min(self.surface_idx, len(ss) - 1))
        return ss[self.surface_idx]

    def _current(self):
        s = self._surface()
        if s is None or not s.hacks:
            return s, None
        self.item_idx = max(0, min(self.item_idx, len(s.hacks) - 1))
        return s, s.hacks[self.item_idx]

    def _daemons(self):
        out = []
        for s in self.app.state.surfaces:
            for it in s.daemons:
                out.append((s, it))
        return out

    # ---- drawing primitives ---------------------------------------------------------------------------

    def put(self, y, x, text, attr=0, maxw=None):
        h, w = self.scr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return 0
        if x < 0:
            text = text[-x:]
            x = 0
        room = w - x if maxw is None else min(maxw, w - x)
        if room <= 0:
            return 0
        text = text[:room]
        try:
            self.scr.addstr(y, x, text, attr)
        except curses.error:
            pass  # writing the bottom-right cell raises after drawing it
        return len(text)

    def box(self, y, x, h, w, title="", attr=None, title_attr=None):
        g = self.g
        attr = self.theme["cyan"] if attr is None else attr
        self.put(y, x, g.tl + g.h * (w - 2) + g.tr, attr)
        for yy in range(y + 1, y + h - 1):
            self.put(yy, x, g.v, attr)
            self.put(yy, x + w - 1, g.v, attr)
        self.put(y + h - 1, x, g.bl + g.h * (w - 2) + g.br, attr)
        if title:
            self.put(y, x + 2, " %s " % title, title_attr if title_attr is not None else self.theme["bone"] | curses.A_BOLD)

    def fill(self, y, x, h, w, attr=0):
        for yy in range(y, y + h):
            self.put(yy, x, " " * w, attr)

    def bar(self, y, x, width, fraction, active=True):
        full, partial, empty = self.g.bar(fraction, width)
        a = self.theme["volt"] if active else self.theme["dim"]
        n = self.put(y, x, full + partial, a)
        self.put(y, x + n, empty, self.theme["dim"])

    # ---- frame -----------------------------------------------------------------------------------------

    def draw(self):
        scr = self.scr
        t = self.theme
        st = self.app.state
        eff = st.active_effects()
        bg = t["bone"]
        if "wash" in eff:
            bg = t.wash(eff["wash"])
        if "invert" in eff:
            bg = bg | curses.A_REVERSE
        scr.bkgd(" ", bg)
        scr.erase()
        h, w = scr.getmaxyx()
        if h < 10 or w < 40:
            self.put(0, 0, "need 40x10, have %dx%d" % (w, h), t["volt"])
            scr.refresh()
            return
        phase = self.app.phase
        if phase == "setup":
            self.draw_setup(h, w)
        elif phase == "pair":
            self.draw_pair(h, w)
        else:
            self.draw_header(0, w)
            self.draw_tabs(1, w)
            body_h = h - 4
            if self.view == "hacks":
                if w >= WIDE:
                    lw = min(60, int(w * 0.44))
                    self.draw_hacks(2, 0, body_h, lw)
                    self.draw_tape(2, lw + 1, body_h, w - lw - 1)
                else:
                    self.draw_hacks(2, 0, body_h, w)
            elif self.view == "tape":
                self.draw_tape(2, 0, body_h, w)
            elif self.view == "daemons":
                self.draw_daemons(2, 0, body_h, w)
            else:
                self.draw_room(2, 0, body_h, w)
            self.draw_footer(h - 1, w)
        self.draw_toast(h - 2, w)
        if "banner" in eff:
            self.draw_banner(h, w, eff["banner"])
        if self.overlay == "preview" and st.preview:
            self.draw_preview(h, w, st.preview)
        elif self.overlay == "help":
            self.draw_help(h, w)
        if self.prompt is not None:
            self.draw_prompt(h, w)
        scr.refresh()

    def draw_header(self, y, w):
        t, g, st = self.theme, self.g, self.app.state
        x = self.put(y, 0, " CONTROL EVERYTHING ", t["bone"] | curses.A_BOLD)
        x += self.put(y, x, g.dot + " ", t["dim"])
        x += self.put(y, x, st.name[:28], t["bone"])
        right = []
        state = st.link_state
        if state == "online":
            right.append((g.proven + " ", t["cyan"]))
            right.append(("LINKED ", t["cyan"] | curses.A_BOLD))
        elif state == "connecting":
            right.append((g.hypothesis + " ", t["dim"]))
            right.append(("CONNECTING%s " % g.ellipsis, t["volt"]))
        elif state == "unauthorized":
            right.append((g.hypothesis + " ", t["dim"]))
            right.append(("TOKEN REJECTED ", t["magenta"] | curses.A_BOLD))
        else:
            right.append((g.hypothesis + " ", t["dim"]))
            retry = ""
            if st.retry_at:
                retry = " %s retry %d s" % (g.dot, max(0, int(round(st.retry_at - time.time()))))
            right.append(("OFFLINE%s " % retry, t["magenta"]))
        right.append((st.server + " ", t["dim"]))
        if st.mode:
            right.append(("%s %s " % (g.dot, st.mode), t["dim"]))
        models = st.running_models()
        for model, secs in models[:2]:
            right.append((" %s %s %d s " % (model, g.dot, secs), t["cyan"] | curses.A_BOLD))
        total = sum(len(s) for s, _ in right)
        rx = max(x + 1, w - total - 1)
        for s, a in right:
            rx += self.put(y, rx, s, a)

    def draw_tabs(self, y, w):
        t, g = self.theme, self.g
        x = 1
        for v in VIEWS:
            label = VIEW_TITLE[v]
            sub = VIEW_SUB.get(v)
            cur = v == self.view or (v == "tape" and self.view == "hacks" and w >= WIDE)
            a = t["volt"] | curses.A_BOLD if v == self.view else (t["bone"] if cur else t["dim"])
            x += self.put(y, x, label, a)
            if sub and w >= 90:
                x += self.put(y, x, " " + sub, t["dim"])
            x += self.put(y, x, "  %s  " % g.v, t["dim"])
        ss = self.app.state.surfaces
        if self.view == "hacks" and ss:
            s = self._surface()
            label = "[ %s %d/%d ]" % (s.device_name[:24], self.surface_idx + 1, len(ss))
            self.put(y, max(x, w - len(label) - 1), label, t["cyan"])

    def draw_footer(self, y, w):
        keys = {
            "hacks": "↑↓ select  ←→ adjust  ⏎/1-9 upload  [ ] device  u undo  : command  ! panic  TAB view  ? help  q quit",
            "tape": "↑↓ PgUp PgDn scroll  G follow  : command  TAB view  ? help  q quit",
            "daemons": "↑↓ select  p pause/start  x stop  : command  TAB view  q quit",
            "room": ": command  ! panic  TAB view  ? help  q quit",
        }[self.view]
        if not self.g.unicode:
            keys = keys.replace("↑↓", "up/down").replace("←→", "left/right").replace("⏎", "enter")
        self.put(y, 1, keys, self.theme["dim"], maxw=w - 2)

    def draw_toast(self, y, w):
        st = self.app.state
        if st.toast and time.time() < st.toast_until:
            self.put(y, 1, st.toast, self.theme["volt"], maxw=w - 2)

    # ---- HACKS -------------------------------------------------------------------------------------------

    def draw_hacks(self, y0, x0, h, w):
        t, g = self.theme, self.g
        s, cur = self._current()
        if s is None:
            self.put(y0 + 1, x0 + 2, "No hacks yet.", t["bone"])
            self.put(y0 + 2, x0 + 2, "Scan a device from the headset: its generated hacks appear here.", t["dim"], maxw=w - 4)
            return
        y = y0
        meta = []
        if s.channel:
            meta.append(s.channel.upper())
        if s.local:
            meta.append("built-in")
        elif s.model_id:
            meta.append(s.model_id + (" (replay)" if s.source == "fixture" else ""))
        if s.rev:
            meta.append("rev %s" % s.rev)
        meta_text = ("  " + ("  %s  " % g.dot).join(meta)) if meta else ""
        head = s.device_name
        room = max(12, w - 3 - len(meta_text))
        if len(head) > room:
            head = head[:room - 1] + g.ellipsis
        self.put(y, x0 + 1, head, t["bone"] | curses.A_BOLD)
        self.put(y, x0 + 1 + len(head), meta_text, t["cyan"], maxw=w - len(head) - 2)
        y += 1
        if getattr(s, "provisional", False):
            self.put(y, x0 + 1, "forging %s hacks appear as the model writes them" % g.dot, t["cyan"], maxw=w - 2)
            y += 1
        elif s.armed is False:
            self.put(y, x0 + 1, "disarmed %s %s" % (g.dot, s.reason or "verifying on the real device"), t["magenta"], maxw=w - 2)
            y += 1
        y += 1
        hacks = s.hacks
        label_w = max(10, min(18, w // 3))
        value_w = 9
        visible = h - (y - y0) - 3
        top = 0
        if self.item_idx >= visible:
            top = self.item_idx - visible + 1
        for i, it in enumerate(hacks[top:top + max(0, visible)]):
            idx = top + i
            sel = it is cur
            row_attr = t["volt"] | curses.A_BOLD if sel else (t["bone"] if it.operable else t["dim"])
            x = x0
            self.put(y, x, (g.sel if sel else " "), t["volt"])
            num = str(idx + 1) if idx < 9 else " "
            self.put(y, x + 1, num, t["dim"] if not sel else t["volt"])
            self.put(y, x + 3, g.kind(it.kind).ljust(3), t["magenta"] if it.kind == "daemon" else t["cyan"])
            self.put(y, x + 7, it.label[:label_w].ljust(label_w), row_attr)
            vx = x + 8 + label_w
            tail_w = w - (vx - x0) - 1
            if it.kind in ("continuous", "stepped", "xy") and tail_w > value_w + 4:
                bw = tail_w - value_w - 1
                self.bar(y, vx, bw, it.fraction(), active=it.operable)
                self.put(y, vx + bw + 1, it.value_text()[:value_w], row_attr)
            elif it.kind == "toggle":
                on = it.value_text() == "ON"
                self.put(y, vx, "[%s]" % ("ON " if on else "OFF"), (t["volt"] if on else t["dim"]))
            else:
                tail = it.detail
                if not it.operable:
                    tail = "disarmed" + ((" %s " % g.dot + tail) if tail else "")
                self.put(y, vx, tail[:max(0, tail_w)], t["magenta"] if not it.operable else t["dim"])
            vt = tapemod.verdict_text(it.verdict, not g.unicode)
            if vt:
                self.put(y, x0 + w - 2, vt, t["ok"] if it.verdict == "ok" else t["fail"])
            y += 1
        # detail for the selected item
        if cur is not None:
            y = y0 + h - 2
            bits = []
            if cur.detail and cur.kind not in ("action",):
                bits.append(cur.detail)
            if cur.oracle:
                bits.append("proof: %s" % cur.oracle)
            if cur.irreversible:
                bits.append("no undo (asks y)")
            if not cur.operable:
                bits.append("disarmed: %s" % (cur.reason or "verifying"))
            if cur.rate_hz:
                bits.append("max %s Hz" % ("%g" % cur.rate_hz))
            self.put(y, x0 + 1, ("  %s  " % g.dot).join(bits), t["dim"], maxw=w - 2)

    # ---- TAPE --------------------------------------------------------------------------------------------

    def draw_tape(self, y0, x0, h, w):
        t, g = self.theme, self.g
        rows = list(self.app.state.tape.rows)
        title = "EVIDENCE TAPE"
        self.put(y0, x0 + 1, title, t["bone"] | curses.A_BOLD)
        if self.tape_scroll:
            self.put(y0, x0 + 2 + len(title), "  (scrolled back %d %s G to follow)" % (self.tape_scroll, g.dot), t["dim"])
        self.put(y0 + 1, x0 + 1, tapemod.header(w - 2), t["dim"], maxw=w - 2)
        avail = h - 2
        end = len(rows) - self.tape_scroll
        start = max(0, end - avail)
        y = y0 + 2
        if not rows:
            self.put(y, x0 + 1, "waiting for the agent%s" % g.ellipsis, t["dim"])
            return
        for r in rows[start:end]:
            self._tape_row(y, x0 + 1, w - 2, r)
            y += 1

    def _tape_row(self, y, x, w, r):
        t, g = self.theme, self.g
        cols = r.columns()
        pos = x
        verdict = tapemod.verdict_text(r.verdict, not g.unicode)
        attrs = [t["dim"], t[VERB_TOKEN.get(r.verb, "bone")] | curses.A_BOLD, t["bone"], t["bone"], t["bone"], t["bone"]]
        if r.kind == "warn":
            attrs[4] = t["magenta"]
        for i, cw in tapemod.layout(w):
            self.put(y, pos, tapemod._fit(cols[i], cw), attrs[i])
            pos += cw + 2
        if verdict:
            self.put(y, pos, verdict, t["ok"] if r.verdict == "ok" else t["fail"])
        pos += 4
        if r.model and pos < x + w - 6:
            self.put(y, pos, r.model, t["cyan"], maxw=x + w - pos)

    # ---- DAEMONS -----------------------------------------------------------------------------------------

    def draw_daemons(self, y0, x0, h, w):
        t, g = self.theme, self.g
        ds = self._daemons()
        self.put(y0, x0 + 1, "DAEMONS", t["magenta"] | curses.A_BOLD)
        self.put(y0, x0 + 9, "automations %s rate-capped at 3 Hz" % g.dot, t["dim"])
        if not ds:
            self.put(y0 + 2, x0 + 2, "No daemons yet. Ask for one: press : and type \"make the light breathe with the synth\".", t["dim"], maxw=w - 4)
            return
        self.daemon_idx = min(self.daemon_idx, len(ds) - 1)
        y = y0 + 2
        for i, (s, it) in enumerate(ds[:h - 3]):
            sel = i == self.daemon_idx
            self.put(y, x0, g.sel if sel else " ", t["volt"])
            self.put(y, x0 + 2, g.daemon, t["magenta"])
            self.put(y, x0 + 6, it.label[:22].ljust(22), t["volt"] | curses.A_BOLD if sel else t["bone"])
            self.put(y, x0 + 30, it.value_text()[:20].ljust(20), t["magenta"] if it.status == "running" else t["dim"])
            self.put(y, x0 + 52, "%s %s" % (s.device_name[:20], (g.dot + " " + it.detail) if it.detail else ""), t["dim"], maxw=w - 53)
            y += 1

    # ---- ROOM --------------------------------------------------------------------------------------------

    def draw_room(self, y0, x0, h, w):
        t, g, st = self.theme, self.g, self.app.state
        y = y0
        self.put(y, x0 + 1, "PAIRED CLIENTS", t["bone"] | curses.A_BOLD)
        y += 1
        devs = sorted(st.devices.values(), key=lambda d: (not d.get("online"), d.get("name", "")))
        if not devs:
            self.put(y, x0 + 2, "presence not received yet", t["dim"])
            y += 1
        for d in devs[:max(0, (h - 4) // 2)]:
            on = d.get("online")
            self.put(y, x0 + 2, g.proven if on else g.hypothesis, t["cyan"] if on else t["dim"])
            me = " (this)" if d.get("deviceId") == st.device_id else ""
            self.put(y, x0 + 6, (d.get("name", "?") + me)[:24].ljust(24), t["bone"] if on else t["dim"])
            self.put(y, x0 + 31, (d.get("kind") or "")[:10].ljust(10), t["dim"])
            self.put(y, x0 + 42, ("online" if on else "offline").ljust(8), t["cyan"] if on else t["dim"])
            self.put(y, x0 + 51, ", ".join(d.get("capabilities") or []), t["dim"], maxw=w - 52)
            y += 1
        y += 1
        self.put(y, x0 + 1, "YOUR DEVICES", t["bone"] | curses.A_BOLD)
        y += 1
        if not st.cards:
            self.put(y, x0 + 2, "nothing identified yet: scan from the headset", t["dim"])
            return
        proven_states = ("linked", "verifying", "verified", "forging", "forged", "arming", "armed", "controlling")
        for cid, c in list(st.cards.items())[:max(0, h - (y - y0) - 1)]:
            ts = st.targets.get(cid) or {}
            state = ts.get("state") or "identified"
            proven = state in proven_states
            self.put(y, x0 + 2, g.proven if proven else g.hypothesis, t["cyan"] if proven else t["dim"])
            self.put(y, x0 + 6, (c.get("name") or cid)[:24].ljust(24), t["bone"])
            self.put(y, x0 + 31, (c.get("category") or "")[:12].ljust(12), t["dim"])
            via = ""
            if ts.get("executorDeviceId"):
                via = " via %s" % ((st.devices.get(ts["executorDeviceId"]) or {}).get("name") or ts["executorDeviceId"])
            self.put(y, x0 + 44, state + via, t["cyan"] if proven else t["volt"], maxw=w - 45)
            y += 1

    # ---- SETUP / PAIR ------------------------------------------------------------------------------------

    def draw_setup(self, h, w):
        t = self.theme
        self.put(1, 2, "CONTROL EVERYTHING", t["bone"] | curses.A_BOLD)
        self.put(2, 2, "DevTerm client %s link setup" % self.g.dot, t["dim"])
        self.put(4, 2, "Where is the Mac running the server (npm run dev)?", t["bone"])
        self.put(5, 2, "It prints its address at start-up: http://<mac-ip>:8787", t["dim"])

    def draw_pair(self, h, w):
        t, g, app = self.theme, self.g, self.app
        info = app.pair_info or {}
        sess = app.pair_session
        state = info.get("state")
        self.put(0, 1, "CONTROL EVERYTHING", t["bone"] | curses.A_BOLD)
        self.put(0, 20, "%s LINK REQUEST %s %s" % (g.dot, g.dot, app.server.display if app.server else ""), t["cyan"])
        if sess is None or not sess.display:
            msg = info.get("detail") or "asking the server for a code%s" % g.ellipsis
            self.put(3, 2, msg, t["volt"] if state != "error" else t["magenta"], maxw=w - 4)
            if state == "error":
                self.put(4, 2, "retrying %s check the Mac address (s to change) and that npm run dev is running" % g.dot, t["dim"], maxw=w - 4)
            self.put(h - 1, 1, "s server  q quit", t["dim"])
            return
        m = qrmod.matrix(sess.qr_payload(app.opts.qr))
        cells = qrmod.cells(m, quiet=2)
        qr_w, qr_h = len(cells[0]), len(cells)
        code = sess.display or sess.code
        big_wide = bigtext.render(code, wide=True, ascii_only=not g.unicode)
        big_small = bigtext.render(code, wide=False, ascii_only=not g.unicode)
        side = None
        for big in (big_wide, big_small):
            if qr_w + 4 + len(big[0]) + 4 <= w and qr_h + 3 <= h:
                side = big
                break
        y0 = 2
        show_qr = qr_h + 4 <= h and qr_w + 2 <= w
        if show_qr:
            self.draw_qr(y0, 2, cells)
        if side is not None and show_qr:
            tx = 2 + qr_w + 4
            ty = y0 + max(0, (qr_h - 15) // 2)
        else:
            tx = 2
            ty = y0 + (qr_h + 1 if show_qr else 0)
            side = big_wide if len(big_wide[0]) + 4 <= w else big_small
        self.put(ty, tx, "this DevTerm wants to join your room", t["bone"])
        ty += 2
        for line in side:
            self.put(ty, tx, line, t["volt"] | curses.A_BOLD)
            ty += 1
        ty += 1
        self.put(ty, tx, "type this code on the Mac", t["bone"])
        self.put(ty + 1, tx, "or look at it from the headset", t["bone"])
        left = sess.seconds_left()
        status = {"pending": "waiting for approval", "approved": "LINK GRANTED", "denied": "denied", "expired": "expired: new code coming"}.get(sess.status, sess.status)
        self.put(ty + 3, tx, "%s %s valid %d:%02d" % (status, g.dot, int(left) // 60, int(left) % 60),
                 t["cyan"] if sess.status == "pending" else t["magenta"])
        if info.get("detail"):
            self.put(ty + 4, tx, info["detail"][:w - tx - 1], t["dim"])
        printer = app.printer
        ptxt = "ticket: %s" % ("printed" if app.ticket_printed else "press p to print") if printer.name == "devterm" else "no printer here %s p saves a ticket preview" % g.dot
        self.put(ty + 5, tx, ptxt, t["dim"], maxw=w - tx - 1)
        self.put(h - 1, 1, "p print ticket  n new code  s server  q quit", t["dim"])

    def draw_qr(self, y, x, cells):
        """Black-on-white half-block QR (two modules per character cell)."""
        t, g = self.theme, self.g
        for r, row in enumerate(cells):
            for c, (top, bottom) in enumerate(row):
                if top and bottom:
                    self.put(y + r, x + c, " ", t.qr_dark)
                elif not top and not bottom:
                    self.put(y + r, x + c, " ", t.qr_light)
                elif top:
                    self.put(y + r, x + c, g.upper if g.unicode else " ", t.qr_light)
                else:
                    self.put(y + r, x + c, g.lower if g.unicode else " ", t.qr_light)

    # ---- overlays ----------------------------------------------------------------------------------------

    def draw_prompt(self, h, w):
        t = self.theme
        p = self.prompt
        y = h - 2
        self.fill(y, 0, 1, w, t["bone"])
        label = p["label"]
        if p["kind"] == "confirm":
            self.put(y, 1, label, t["volt"] | curses.A_BOLD, maxw=w - 2)
            return
        x = self.put(y, 1, label + ": ", t["volt"] | curses.A_BOLD)
        text = p["text"]
        room = w - x - 3
        shown = text[-room:] if room > 0 else ""
        self.put(y, 1 + x, shown + "_", t["bone"])

    def draw_banner(self, h, w, text):
        t = self.theme
        lines = bigtext.fit(str(text)[:24].upper(), w - 4, ascii_only=not self.g.unicode) or [str(text)]
        bh = len(lines) + 2
        bw = min(w - 2, max(len(l) for l in lines) + 6)
        y = max(0, (h - bh) // 2)
        x = max(0, (w - bw) // 2)
        self.fill(y, x, bh, bw, t["bone"])
        self.box(y, x, bh, bw, attr=t["volt"])
        for i, line in enumerate(lines):
            self.put(y + 1 + i, x + (bw - len(line)) // 2, line, t["volt"] | curses.A_BOLD)

    def draw_preview(self, h, w, preview):
        t = self.theme
        lines = preview.get("lines") or []
        bw = min(w - 2, 38)
        inner = bw - 4
        bh = min(h - 2, len(lines) + 4)
        y = max(0, (h - bh) // 2)
        x = max(0, (w - bw) // 2)
        self.fill(y, x, bh, bw, t["bone"])
        self.box(y, x, bh, bw, "RECEIPT PREVIEW", attr=t["cyan"])
        for i, (style, text) in enumerate(lines[:bh - 4]):
            yy = y + 1 + i
            if style == "qr":
                self.put(yy, x + 2, text[:inner], t.qr_light)
            elif style in ("title", "big"):
                self.put(yy, x + 2, text[:inner], t["volt"] | curses.A_BOLD)
            elif style in ("dim", "rule"):
                self.put(yy, x + 2, text[:inner], t["dim"])
            else:
                self.put(yy, x + 2, text[:inner], t["bone"])
        path = preview.get("path") or ""
        self.put(y + bh - 2, x + 2, ("saved: " + os.path.basename(path))[:inner], t["dim"])
        self.put(y + bh - 1, x + 2, " any key ", t["dim"])

    def draw_help(self, h, w):
        t = self.theme
        text = [
            "HACKS   up/down select, left/right adjust (-/+ coarse), enter or 1-9 upload",
            "        uploading is the human confirmation; paper hacks ask y first",
            "        [ ] previous/next device, u undo (typed command \"undo\")",
            "TAPE    every event: time, verb, device, command, state, measure, verdict",
            "        green/red marks only come from an oracle (camera, mic, wire)",
            "DAEMONS p pause/start, x stop (typed commands to the agent)",
            ":       type a command for the agent (\"make the light breathe\")",
            "!       PANIC: stop everything (asks y)",
            "R       reconnect now, X forget pairing and pair again, q quit",
        ]
        bw = min(w - 2, max(len(s) for s in text) + 4)
        bh = min(h - 2, len(text) + 2)
        y = max(0, (h - bh) // 2)
        x = max(0, (w - bw) // 2)
        self.fill(y, x, bh, bw, t["bone"])
        self.box(y, x, bh, bw, "KEYS")
        for i, s in enumerate(text[:bh - 2]):
            self.put(y + 1 + i, x + 2, s, t["bone"], maxw=bw - 4)
