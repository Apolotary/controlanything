"""Everything the screens show, built from hub messages. Mutated only on the UI thread."""
import time

from . import surface as surface_mod
from .tape import Names, Row, Tape, rows_from_message


class AppState(object):
    def __init__(self, name="DevTerm", server="", demo=False):
        self.name = name
        self.server = server
        self.demo = demo
        self.device_id = None
        self.mode = ""
        self.link_state = "idle"
        self.link_detail = ""
        self.retry_at = None
        self.link_since = time.time()
        self.devices = {}  # deviceId -> DeviceInfo (presence)
        self.cards = {}  # cardId -> device.card payload
        self.targets = {}  # cardId -> target.status payload
        self.surfaces = []  # one per card (latest spec wins), local self-test surface last
        self.tape = Tape()
        self.names = Names()
        self.running = {}  # stepId -> (model, startedAt)
        self.toast = None
        self.toast_until = 0.0
        self.effect = {}  # screen effects from the executor: invert / wash / banner, with "until"
        self.preview = None  # last receipt preview (no paper here)
        self.arm_requests = {}
        self.version = 0

    # ---- helpers ------------------------------------------------------------------------------------

    def touch(self):
        self.version += 1

    def say(self, text, seconds=4.0):
        self.toast = text
        self.toast_until = time.time() + seconds
        self.touch()

    def add_row(self, row):
        self.tape.add(row)
        self.touch()

    def surface_index(self, spec_id=None, card_id=None):
        for i, s in enumerate(self.surfaces):
            if (spec_id and s.spec_id == spec_id) or (card_id and s.card_id == card_id):
                return i
        return -1

    def add_surface(self, surf):
        """A new spec replaces the old one for the same card (or the same specId)."""
        i = self.surface_index(surf.spec_id, surf.card_id)
        if i >= 0:
            old = self.surfaces[i]
            for it in surf.items:  # keep values the user (or another controller) already set
                prev = old.find(it.id)
                if prev is not None and prev.kind == it.kind and it.kind in ("continuous", "stepped", "toggle", "xy"):
                    it.value = prev.value
            self.surfaces[i] = surf
        else:
            local = [s for s in self.surfaces if s.local]
            self.surfaces = [s for s in self.surfaces if not s.local] + [surf] + local
        self.touch()
        return surf

    def running_models(self, now=None):
        """[(model, seconds)] for Meta model calls in flight, for the status line."""
        now = now or time.time()
        out = []
        for model, started in self.running.values():
            if model:
                out.append((model, max(0.0, now - started)))
        return sorted(out, key=lambda x: -x[1])[:3]

    # ---- link events --------------------------------------------------------------------------------

    def on_status(self, data):
        state = data.get("state")
        if state != self.link_state:
            self.link_since = time.time()
        self.link_state = state
        self.link_detail = data.get("detail") or ""
        retry = data.get("retryIn")
        self.retry_at = (time.time() + retry) if retry else None
        self.touch()

    def apply(self, m):
        """Update state from one incoming message (relayed or from the server)."""
        t = m.get("type") or ""
        p = m.get("payload") or {}
        if t == "welcome":
            self.device_id = p.get("deviceId")
            self.names.me = self.device_id
            self.mode = p.get("mode") or ""
            self.name = p.get("name") or self.name
        elif t == "presence":
            self.devices = {d.get("deviceId"): d for d in (p.get("devices") or []) if isinstance(d, dict)}
            self.names.devices = self.devices
        elif t == "device.card":
            if p.get("cardId"):
                self.cards[p["cardId"]] = p
                self.names.cards = self.cards
        elif t == "target.status":
            if p.get("cardId"):
                self.targets[p["cardId"]] = p
        elif t == "driver.spec":
            for a in p.get("actions") or []:
                if isinstance(a, dict) and a.get("actionId"):
                    self.names.actions[a["actionId"]] = a.get("label") or a["actionId"]
        elif t == "driver.status":
            for a in p.get("actions") or []:
                if isinstance(a, dict) and a.get("actionId") and a.get("label"):
                    self.names.actions[a["actionId"]] = a["label"]
        elif t == "ui.spec":
            surf = surface_mod.from_ui_spec(p)
            if surf.items:
                self.add_surface(surf)
        elif t == "agent.step":
            sid = p.get("stepId")
            if p.get("status") == "running":
                self.running[sid] = (p.get("model") or "", (p.get("startedAt") or time.time() * 1000) / 1000.0)
            else:
                self.running.pop(sid, None)
        elif t == "control.event":
            self._mirror(p)
        elif t == "arm.request":
            self.arm_requests[p.get("armId")] = p
        elif t == "arm.result":
            self.arm_requests.pop(p.get("armId"), None)
        for row in rows_from_message(m, self.names):
            self.tape.add(row)
        self.touch()

    def _mirror(self, p):
        """Another controller moved a control: move our bar too."""
        wid = p.get("widgetId")
        v = p.get("value")
        for s in self.surfaces:
            if p.get("specId") and s.spec_id != p.get("specId"):
                continue
            it = s.find(wid)
            if it is None:
                continue
            if it.kind == "xy" and isinstance(v, dict):
                it.value = v.get("x", it.value)
                if it.y is not None:
                    it.y["value"] = v.get("y", it.y.get("value"))
            elif it.kind in ("continuous", "stepped") and isinstance(v, (int, float)) and not isinstance(v, bool):
                it.value = it.quantize(v)
            elif it.kind == "toggle":
                it.value = v if (it.numeric_toggle and not isinstance(v, bool)) else bool(v)

    # ---- executor events ----------------------------------------------------------------------------

    def on_exec(self, data):
        ok = data.get("ok")
        state = data.get("state") or ""
        measure = data.get("measure") or ""
        if state == "failed" and data.get("error"):
            measure = "%s: %s" % (data["error"], measure)
        self.add_row(Row("EXEC", "devterm", data.get("op") or "", state, measure, None, kind="exec" if ok is not False else "warn",
                         key="ex:" + str(data.get("execId"))))

    def on_effect(self, data):
        now = time.time()
        if data.get("reset"):
            self.effect = {}
        else:
            until = now + data.get("ms", 1500) / 1000.0
            for k in ("invert", "wash", "banner"):
                if k in data:
                    self.effect[k] = (data[k], until)
        self.touch()

    def active_effects(self, now=None):
        now = now or time.time()
        live = {}
        for k, (v, until) in list(self.effect.items()):
            if until > now:
                live[k] = v
            else:
                del self.effect[k]
        return live
