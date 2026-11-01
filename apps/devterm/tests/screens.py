"""Render the curses TUI into a text buffer (no terminal needed): a fake window + a mono theme.

Used by test_tui.py, and by hand to look at the screens at any size:
    python3 tests/screens.py 128 30
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "src"))

import fixtures as fx  # noqa: E402

from ce_devterm import app as app_mod  # noqa: E402
from ce_devterm import config, theme  # noqa: E402
from ce_devterm import tui as tui_mod  # noqa: E402


class FakeScreen(object):
    def __init__(self, h, w):
        self.h, self.w = h, w
        self.erase()
        self.keys = []

    def erase(self):
        self.rows = [[" "] * self.w for _ in range(self.h)]

    def getmaxyx(self):
        return self.h, self.w

    def addstr(self, y, x, text, attr=0):
        for i, ch in enumerate(text):
            if 0 <= y < self.h and 0 <= x + i < self.w:
                self.rows[y][x + i] = ch

    def bkgd(self, ch, attr=0):
        pass

    def refresh(self):
        pass

    def text(self):
        return "\n".join("".join(r).rstrip() for r in self.rows)


class FakeLink(object):
    online = True
    state = "online"

    def __init__(self):
        self.sent = []

    def send(self, type_, payload, to=None, keep=False):
        self.sent.append((type_, payload, to))
        return True

    def stop(self):
        pass

    def reconnect_now(self):
        pass


def make_app(tmpdir):
    opts = app_mod.Options(server=config.parse_server("192.168.1.4:8787"), name="DevTerm", printer="file", print_dir=tmpdir,
                           identity_path=os.path.join(tmpdir, "device.json"))
    a = app_mod.App(opts)
    a.phase = "run"
    a.link = FakeLink()
    st = a.state
    st.on_status({"state": "online", "detail": "DevTerm · live"})
    st.apply(fx.env("welcome", {"deviceId": "dev-1", "name": "DevTerm", "mode": "live"}))
    st.apply(fx.env("presence", {"spaceId": "s", "reason": "join", "devices": [
        {"deviceId": "dev-1", "name": "DevTerm", "kind": "devterm", "role": "device", "capabilities": ["display", "printer"], "canApprove": False, "online": True, "connections": 1, "pairedAt": 1},
        {"deviceId": "dev-card", "name": "Cardputer", "kind": "cardputer", "role": "device", "capabilities": ["ir"], "canApprove": False, "online": True, "connections": 1, "pairedAt": 1},
        {"deviceId": "dev-quest", "name": "Quest 3", "kind": "quest", "role": "hmd", "capabilities": ["camera", "hands"], "canApprove": True, "online": False, "connections": 0, "pairedAt": 1},
    ]}))
    st.apply(fx.env("device.card", {"cardId": "card_light", "name": "Ceiling light", "maker": "KOIZUMI", "model": "KRH-TG-9A", "category": "lighting",
                                    "confidence": 0.8, "protocols": ["ir"], "evidence": []}))
    st.apply(fx.env("target.status", {"cardId": "card_light", "state": "verified", "since": 1, "executorDeviceId": "dev-card"}))
    st.apply(fx.env("agent.step", {"stepId": "a1", "cardId": "card_light", "phase": "identify", "status": "ok", "title": "KOIZUMI KRH-TG-9A remote", "model": "muse-spark-1.3", "latencyMs": 2140}))
    st.apply(fx.env("agent.step", {"stepId": "a2", "cardId": "card_light", "phase": "link", "status": "ok", "title": "#3 captured", "evidence": "68 marks"}))
    st.apply(fx.env("verify.result", fx.evidence(pass_=False, delta=0.01)))
    ev = fx.evidence()
    ev["evidenceId"] = "ev2"
    st.apply(fx.env("verify.result", ev))
    st.apply(fx.env("ui.spec", fx.light_ui_spec()))
    st.apply(fx.env("agent.step", {"stepId": "a3", "cardId": "card_light", "phase": "forge", "status": "running", "title": "forging hacks", "model": "muse-spark-1.3", "startedAt": (time.time() - 25) * 1000}))
    return a


def make_tui(a, h, w):
    t = tui_mod.Tui(a)
    t.scr = FakeScreen(h, w)
    t.theme = theme.Theme(mono=True, uni=True)
    t.g = t.theme.glyphs
    return t


def render(t, view=None):
    if view:
        t.view = view
    t.draw()
    return t.scr.text()


def wait_for_file(d, suffix, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(f.endswith(suffix) for f in os.listdir(d)):
            return True
        time.sleep(0.05)
    return False


if __name__ == "__main__":
    import tempfile
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 128
    h = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    a = make_app(tempfile.mkdtemp())
    t = make_tui(a, h, w)
    for v in ("hacks", "tape", "daemons", "room"):
        print(("=" * 20) + " " + v + " " + ("=" * 20))
        print(render(t, v))
