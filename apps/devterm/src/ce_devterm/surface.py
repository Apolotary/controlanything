"""ui.spec -> a flat list of 2D items the terminal can draw and operate.

Sources, merged by id (a gen3d control whose id equals a hack id drives that hack):
  hackset.hacks   action (one-shot) · control (param min..max) · daemon
  hackset.daemons persistent automations (rate-capped)
  gen3d.controls  continuous · stepped · toggle · trigger · xy  (+ armed state)
  widgets         v0 flat list (knob, fader, button, toggle, xy, pads)

Firing (protocol v1): control.event {widgetId: <control/hack id>, value, phase}; an action hack sends
value true with phase "end"; a control hack sends a number inside its param range.
"""
import math

KIND_GLYPH = {"action": ">", "continuous": "(o)", "stepped": "(o)", "toggle": "(o)", "xy": "(o)", "pads": "(o)", "daemon": "oo"}


def _num(v, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


class Item(object):
    def __init__(self, id_, kind, label, detail="", min_=0.0, max_=1.0, step=None, value=None, unit="",
                 step_labels=None, armed=None, reason="", confirm=False, irreversible=False, channel="",
                 verdict=None, status="", rate_hz=None, oracle="", hack_kind=None, pads=0, y=None):
        self.id = id_
        self.kind = kind
        self.label = label
        self.detail = detail or ""
        self.min = min_
        self.max = max_ if max_ != min_ else min_ + 1.0
        self.step = step
        self.unit = unit or ""
        self.step_labels = list(step_labels or [])
        self.armed = armed
        self.reason = reason or ""
        self.confirm = confirm
        self.irreversible = irreversible
        self.channel = channel or ""
        self.verdict = verdict
        self.status = status or ""
        self.rate_hz = rate_hz
        self.oracle = oracle or ""
        self.hack_kind = hack_kind
        self.pads = pads
        self.pad_index = 0
        self.y = y  # xy only: {min, max, value}
        if value is None:
            value = False if kind == "toggle" else (self.min if kind in ("continuous", "stepped") else None)
        self.value = value
        self.numeric_toggle = False  # hack controls with a toggle archetype send numbers, not booleans

    # ---- geometry of the value --------------------------------------------------------------------

    @property
    def span(self):
        return self.max - self.min

    def fraction(self, value=None):
        v = self.value if value is None else value
        if isinstance(v, bool) or v is None or isinstance(v, dict):
            return 1.0 if v is True else 0.0
        return max(0.0, min(1.0, (float(v) - self.min) / self.span))

    def quantize(self, v):
        v = max(self.min, min(self.max, float(v)))
        if self.step:
            v = self.min + round((v - self.min) / self.step) * self.step
            v = max(self.min, min(self.max, v))
        if self.step and float(self.step).is_integer() and float(self.min).is_integer():
            return int(round(v))
        return round(v, 4)

    def nudge(self, direction, coarse=False):
        """New value after one key press left (-1) or right (+1)."""
        if self.kind == "toggle":
            on = direction > 0
            return (self.max if on else self.min) if self.numeric_toggle else on
        if self.kind == "pads":
            self.pad_index = max(0, min(max(0, self.pads - 1), self.pad_index + direction))
            return self.value
        if self.kind not in ("continuous", "stepped", "xy"):
            return self.value
        cur = self.value if isinstance(self.value, (int, float)) and not isinstance(self.value, bool) else self.min
        if self.kind == "stepped":
            inc = self.step or 1.0
        else:
            inc = self.span / (5.0 if coarse else 20.0)
            if self.step:
                inc = max(self.step, round(inc / self.step) * self.step)
        return self.quantize(cur + direction * inc)

    # ---- text ----------------------------------------------------------------------------------------

    def value_text(self, value=None):
        v = self.value if value is None else value
        if self.kind == "toggle":
            on = (v is True) or (self.numeric_toggle and isinstance(v, (int, float)) and v > self.min)
            return "ON" if on else "OFF"
        if self.kind == "action":
            return ""
        if self.kind == "daemon":
            rate = (" %s Hz" % _fmt(self.rate_hz)) if self.rate_hz else ""
            return (self.status or "proposed") + rate
        if self.kind == "pads":
            return "pad %d/%d" % (self.pad_index + 1, max(1, self.pads))
        if v is None or isinstance(v, (bool, dict)):
            return "-"
        if self.kind == "stepped" and self.step_labels:
            idx = int(round((float(v) - self.min) / (self.step or 1.0)))
            if 0 <= idx < len(self.step_labels):
                return self.step_labels[idx]
        unit = self.unit
        if unit == "%":
            return "%s %%" % _fmt(v)
        return (_fmt(v) + ((" " + unit) if unit else "")).strip()

    @property
    def glyph(self):
        return KIND_GLYPH.get(self.kind, ">")

    @property
    def operable(self):
        return self.armed is not False


def _fmt(v):
    f = float(v)
    if f.is_integer():
        return str(int(f))
    return ("%.2f" % f).rstrip("0").rstrip(".")


class Surface(object):
    def __init__(self, spec_id, title, card_id=None, device_name="", items=None, source="", model_id="",
                 armed=None, reason="", rev=None, channel=""):
        self.spec_id = spec_id
        self.title = title
        self.card_id = card_id
        self.device_name = device_name or title
        self.items = items or []
        self.source = source or ""
        self.model_id = model_id or ""
        self.armed = armed
        self.reason = reason or ""
        self.rev = rev
        self.channel = channel or ""
        self.local = False  # built-in (hand-written) surfaces, e.g. the DevTerm's own self-test hacks

    def find(self, item_id):
        for it in self.items:
            if it.id == item_id:
                return it
        return None

    @property
    def hacks(self):
        return [i for i in self.items if i.kind != "daemon"]

    @property
    def daemons(self):
        return [i for i in self.items if i.kind == "daemon"]


# ---- builders -------------------------------------------------------------------------------------

_GEN3D_KIND = {"continuous": "continuous", "stepped": "stepped", "toggle": "toggle", "trigger": "action", "xy": "xy"}
_V0_KIND = {"knob": "continuous", "fader": "continuous", "button": "action", "toggle": "toggle", "xy": "xy", "pads": "pads"}
_HACK_STATUS_VERDICT = {"verified": "ok", "failed": "fail"}


def _range(r, default=(0.0, 1.0)):
    if not isinstance(r, dict):
        return default[0], default[1], None
    lo = _num(r.get("min"), default[0])
    hi = _num(r.get("max"), default[1])
    step = _num(r.get("step"))
    if step is not None and step <= 0:
        step = None
    return lo, hi, step


def _gen3d_item(c, spec_armed, spec_reason):
    kind = _GEN3D_KIND.get(c.get("kind"), "continuous")
    lo, hi, step = _range(c.get("range"))
    if kind == "stepped" and step is None:
        step = 1.0
    armed = c.get("armed")
    if armed is None:
        armed = spec_armed
    default = c.get("default")
    if kind == "xy":
        ylo, yhi, _ = _range(c.get("yRange"))
        d = default if isinstance(default, dict) else {}
        it = Item(c.get("id"), "xy", c.get("label") or c.get("id"), detail=c.get("description") or "", min_=lo, max_=hi,
                  step=step, value=_num(d.get("x"), lo), unit=c.get("unit") or "", armed=armed, reason=spec_reason,
                  y={"min": ylo, "max": yhi, "value": _num(d.get("y"), ylo)})
        return it
    value = default if not isinstance(default, dict) else None
    if kind in ("continuous", "stepped") and not isinstance(value, (int, float)):
        value = lo
    if kind == "toggle":
        value = bool(value)
    return Item(c.get("id"), kind, c.get("label") or c.get("id"), detail=c.get("description") or "", min_=lo, max_=hi,
                step=step, value=value, unit=c.get("unit") or "", step_labels=c.get("stepLabels"), armed=armed,
                reason=spec_reason)


def _hack_item(h, channel):
    hk = h.get("kind") or "action"
    status = h.get("status") or ""
    verdict = _HACK_STATUS_VERDICT.get(status)
    armed = None
    if status == "verified":
        armed = True
    elif status in ("locked", "failed"):
        armed = False
    confirm = h.get("confirm") == "hold"
    irreversible = confirm or h.get("reversible") is False
    oracle = (h.get("oracle") or {}).get("type") or ""
    common = dict(detail=h.get("blurb") or "", armed=armed, confirm=confirm, irreversible=irreversible, channel=channel,
                  verdict=verdict, status=status, oracle=oracle, hack_kind=hk, rate_hz=_num(h.get("max_rate_hz")))
    name = h.get("name") or h.get("id")
    if hk == "control":
        params = [p for p in (h.get("params") or []) if isinstance(p, dict)]
        ctl = h.get("control") or {}
        param = None
        for p in params:
            if p.get("id") == ctl.get("param"):
                param = p
        if param is None and params:
            param = params[0]
        lo = _num((param or {}).get("min"), 0.0)
        hi = _num((param or {}).get("max"), 1.0)
        step = _num((param or {}).get("step"))
        default = _num((param or {}).get("default"), lo)
        arch = ctl.get("archetype")
        if arch == "toggle":
            it = Item(h.get("id"), "toggle", name, min_=lo, max_=hi, value=default, unit=(param or {}).get("unit") or "", **common)
            it.numeric_toggle = True
            return it
        if arch == "button":
            return Item(h.get("id"), "action", name, min_=lo, max_=hi, value=hi, **common)
        kind = "stepped" if (step and (hi - lo) / step <= 12) else "continuous"
        return Item(h.get("id"), kind, name, min_=lo, max_=hi, step=step, value=default, unit=(param or {}).get("unit") or "", **common)
    if hk == "daemon":
        return Item(h.get("id"), "daemon", name, **common)
    return Item(h.get("id"), "action", name, **common)


def _daemon_item(d):
    return Item(d.get("id"), "daemon", d.get("name") or d.get("id"), detail=d.get("blurb") or "",
                rate_hz=_num(d.get("max_rate_hz")), status=d.get("status") or "proposed", hack_kind="daemon")


def _v0_item(w):
    kind = _V0_KIND.get(w.get("kind"), "continuous")
    lo, hi, step = _range(w.get("range"))
    default = w.get("default")
    if kind == "xy":
        ylo, yhi, _ = _range(w.get("yRange"))
        d = default if isinstance(default, dict) else {}
        return Item(w.get("id"), "xy", w.get("label") or w.get("id"), detail=w.get("description") or "", min_=lo, max_=hi,
                    step=step, value=_num(d.get("x"), lo), unit=w.get("unit") or "", y={"min": ylo, "max": yhi, "value": _num(d.get("y"), ylo)})
    if kind == "pads":
        it = Item(w.get("id"), "pads", w.get("label") or w.get("id"), detail=w.get("description") or "", pads=len(w.get("pads") or []) or 1)
        return it
    if kind == "toggle":
        default = bool(default)
    elif kind == "continuous" and not isinstance(default, (int, float)):
        default = lo
    return Item(w.get("id"), kind, w.get("label") or w.get("id"), detail=w.get("description") or "", min_=lo, max_=hi,
                step=step, value=default, unit=w.get("unit") or "")


def from_ui_spec(p):
    """Normalise a ui.spec payload (v0 or v1). Returns a Surface (possibly with no items)."""
    gen3d = p.get("gen3d") if isinstance(p.get("gen3d"), dict) else None
    hackset = p.get("hackset") if isinstance(p.get("hackset"), dict) else None
    device = (hackset or {}).get("device") or {}
    channel = ((device.get("channel") or {}).get("type")) or ""
    state = (gen3d or {}).get("state") or {}
    spec_armed = state.get("armed") if isinstance(state.get("armed"), bool) else None
    spec_reason = state.get("reason") or ""
    title = p.get("title") or device.get("name") or (gen3d or {}).get("title") or "Controls"
    dev_name = device.get("name") or ((gen3d or {}).get("device") or {}).get("name") or title
    items = []
    by_id = {}

    if hackset:
        for h in hackset.get("hacks") or []:
            if isinstance(h, dict) and h.get("id"):
                it = _hack_item(h, channel)
                by_id[it.id] = it
                items.append(it)
    if gen3d:
        for c in gen3d.get("controls") or []:
            if not isinstance(c, dict) or not c.get("id"):
                continue
            g = _gen3d_item(c, spec_armed, spec_reason)
            h = by_id.get(g.id)
            if h is None:
                by_id[g.id] = g
                items.append(g)
                continue
            # the gen3d control drives the hack of the same id: keep the hack's verb name and verdict,
            # take the control's range/kind/armed state
            h.armed = g.armed if g.armed is not None else h.armed
            h.reason = g.reason or h.reason
            if h.kind != "action" and g.kind in ("continuous", "stepped", "toggle", "xy"):
                h.kind, h.min, h.max, h.step = g.kind, g.min, g.max, g.step or h.step
                h.step_labels = g.step_labels or h.step_labels
                h.unit = h.unit or g.unit
                h.y = g.y
                if h.value is None or not h.min <= _num(h.value, h.min) <= h.max:
                    h.value = g.value
    if hackset:
        for d in hackset.get("daemons") or []:
            if isinstance(d, dict) and d.get("id") and d.get("id") not in by_id:
                it = _daemon_item(d)
                by_id[it.id] = it
                items.append(it)
    if not items:
        for w in p.get("widgets") or []:
            if isinstance(w, dict) and w.get("id"):
                it = _v0_item(w)
                by_id[it.id] = it
                items.append(it)

    surf = Surface(p.get("specId") or "spec", title, card_id=p.get("cardId") or device.get("id"), device_name=dev_name,
                   items=items, source=p.get("source") or (hackset or {}).get("source") or "",
                   model_id=p.get("modelId") or (hackset or {}).get("modelId") or (gen3d or {}).get("modelId") or "",
                   armed=spec_armed, reason=spec_reason, rev=p.get("rev"), channel=channel)
    return surf


def event_value(item, value=None):
    """The control.event value for firing/adjusting `item` (protocol v1 rules)."""
    v = item.value if value is None else value
    if item.kind == "action":
        if item.hack_kind == "control":  # a button-archetype control hack sends its param max
            return item.max
        return True
    if item.kind == "toggle":
        if item.numeric_toggle:
            return v if isinstance(v, (int, float)) and not isinstance(v, bool) else (item.max if v else item.min)
        return bool(v)
    if item.kind == "xy":
        return {"x": float(v if isinstance(v, (int, float)) else item.min), "y": float((item.y or {}).get("value") or 0.0)}
    if item.kind == "pads":
        return 0.8
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    return item.min
