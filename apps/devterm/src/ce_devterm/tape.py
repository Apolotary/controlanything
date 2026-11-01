"""The evidence tape: one line per event, fixed columns.

    05:41:12  SENT      light       dimmer        SEEN          -38 % lum     ✓
    05:41:13  SENT      light       0x2A          SEEN          no change     ✗
    05:42:02  LEARN     light       #3 captured   68 marks
    05:43:10  REFUSED   synth       EP-133 answered · wrong device             ✗

Green/red verdicts appear only for oracle results (camera, mic, wire); every other state is a word:
requested · working · awaiting evidence · sent · seen / heard / wired · no reaction · failed.
"""
import collections
import time

PHASE_VERB = {
    "capture": "SCAN", "scan": "SCAN", "identify": "IDENTIFY", "link": "LINK", "research": "RESEARCH",
    "plan": "PLAN", "drive": "DRIVER", "codegen": "DRIVER", "verify": "VERIFY", "forge": "FORGE", "arm": "ARM",
    "deploy": "DEPLOY", "ui": "FORGE", "control": "SENT", "other": "STEP",
}
STEP_STATE = {"pending": "requested", "running": "working", "ok": "ok", "fail": "failed"}
SENSE_STATE = {"camera": "SEEN", "audio": "HEARD", "ack": "ACKED", "none": "UNCHECKED"}
TARGET_MILESTONES = {
    "needs-companion": ("LINK", "needs companion"), "linked": ("LINK", "linked"), "verified": ("VERIFY", "verified"),
    "armed": ("ARM", "armed"), "controlling": ("SENT", "controlling"), "failed": ("STEP", "failed"),
}


class Row(object):
    __slots__ = ("key", "ts", "verb", "device", "command", "state", "measure", "verdict", "model", "kind")

    def __init__(self, verb, device="", command="", state="", measure="", verdict=None, model="", kind="info", key=None, ts=None):
        self.key = key
        self.ts = ts if ts is not None else time.time()
        self.verb = verb
        self.device = device or ""
        self.command = command or ""
        self.state = state or ""
        self.measure = measure or ""
        self.verdict = verdict
        self.model = model or ""
        self.kind = kind

    def columns(self):
        return (time.strftime("%H:%M:%S", time.localtime(self.ts)), self.verb, self.device, self.command, self.state, self.measure)


class Tape(object):
    def __init__(self, maxlen=400):
        self.rows = collections.deque(maxlen=maxlen)
        self.version = 0

    def add(self, row):
        """Append, or update in place when a row with the same key exists (agent steps, exec acks)."""
        if row.key is not None:
            for i in range(len(self.rows) - 1, max(-1, len(self.rows) - 80), -1):
                old = self.rows[i]
                if old.key == row.key:
                    row.ts = old.ts
                    self.rows[i] = row
                    self.version += 1
                    return row
        self.rows.append(row)
        self.version += 1
        return row

    def __len__(self):
        return len(self.rows)


WIDTHS = (8, 8, 10, 14, 12, 14)
HEADERS = ("TIME", "VERB", "DEVICE", "COMMAND", "STATE", "MEASURE")

# (column index, width) per layout, widest first; the measure and the verdict survive longest, the time
# goes first (the newest row is at the bottom anyway)
LAYOUTS = (
    (96, ((0, 8), (1, 8), (2, 12), (3, 16), (4, 12), (5, 14))),
    (84, ((0, 8), (1, 8), (2, 9), (3, 13), (4, 10), (5, 12))),
    (66, ((1, 8), (2, 8), (3, 13), (4, 9), (5, 12))),
    (0, ((1, 8), (2, 7), (3, 11), (5, 11))),
)


def layout(width):
    """Columns that fit `width` (2-space gaps, 3 cells kept for the verdict)."""
    for min_w, cols in LAYOUTS:
        if width >= min_w:
            return cols
    return LAYOUTS[-1][1]


def _fit(s, w):
    s = str(s)
    if len(s) <= w:
        return s.ljust(w)
    return s[:max(0, w - 1)] + "…"


def format_row(row, width, ascii_only=False):
    """The row as text (without the verdict/model columns, which the TUI colours separately)."""
    cols = row.columns()
    return "  ".join(_fit(cols[i], w) for i, w in layout(width))


def header(width):
    return "  ".join(_fit(HEADERS[i], w) for i, w in layout(width))


def verdict_text(verdict, ascii_only=False):
    if verdict == "ok":
        return "OK" if ascii_only else "✓"
    if verdict == "fail":
        return "NO" if ascii_only else "✗"
    return ""


# ---- message -> row ---------------------------------------------------------------------------------

def _pct(x):
    return "%+d %%" % int(round(x * 100))


def evidence_measure(obs, passed):
    metric = obs.get("metric")
    delta = obs.get("delta")
    try:
        delta = float(delta)
    except (TypeError, ValueError):
        return ""
    thr = obs.get("threshold")
    try:
        small = thr is not None and abs(delta) < float(thr)
    except (TypeError, ValueError):
        small = False
    if not passed and small:
        return "no change"
    if metric == "luma-mask-vs-ring":
        return _pct(delta) + " lum"
    if metric == "rb-ratio":
        return _pct(delta) + " R/B"
    if metric == "centroid":
        return ("%+d Hz" % int(round(delta))) if abs(delta) >= 2 else (_pct(delta) + " tone")
    if metric == "rms":
        return ("%+.1f dB" % delta) if abs(delta) >= 0.5 else (_pct(delta) + " level")
    if metric == "ack":
        return "acked" if passed else "no ack"
    return "%+.2f" % delta


SHORT_CATEGORY = {
    "lighting": "light", "synthesizer": "synth", "drum-machine": "drums", "sampler": "sampler", "groovebox": "groovebox",
    "midi-controller": "controller", "audio-interface": "audio", "effects": "effects", "remote-control": "remote",
    "appliance": "appliance", "computer": "computer", "microcontroller": "node", "phone": "phone",
}


class Names(object):
    """Lookups the formatter needs (filled by the app state)."""

    def __init__(self):
        self.cards = {}
        self.devices = {}
        self.actions = {}
        self.me = None

    def card(self, card_id):
        """The short tape name: "light", "synth" (by category, unless two cards share it), else the card name."""
        if not card_id:
            return ""
        c = self.cards.get(card_id)
        if not isinstance(c, dict):
            return card_id
        short = SHORT_CATEGORY.get(c.get("category") or "")
        if short and sum(1 for o in self.cards.values() if isinstance(o, dict) and o.get("category") == c.get("category")) == 1:
            return short
        return c.get("name") or card_id

    def device(self, device_id):
        if not device_id:
            return ""
        d = self.devices.get(device_id)
        return (d.get("name") if isinstance(d, dict) else None) or device_id

    def action(self, action_id):
        return self.actions.get(action_id) or (action_id.split(".")[-1] if action_id else "")


def _op_summary(op):
    if not isinstance(op, dict):
        return ""
    k = op.get("kind")
    if k == "local":
        arg = op.get("arg")
        if isinstance(arg, dict):
            arg = arg.get("title") or arg.get("text") or ""
        return ("%s %s" % (op.get("op", ""), arg if isinstance(arg, (str, int, float)) else "")).strip()
    if k == "midi":
        return "%s %s" % (op.get("msg", "midi"), op.get("number", ""))
    if k == "ir":
        return op.get("ref") or "ir %s" % op.get("protocol", "")
    return k or ""


def rows_from_message(m, names):
    """Zero or more tape rows for one incoming envelope."""
    t = m.get("type") or ""
    p = m.get("payload") or {}
    out = []
    if isinstance(p.get("tape"), dict):  # a server (or x.* sender) can write a row directly
        r = p["tape"]
        out.append(Row(str(r.get("verb", "NOTE"))[:8].upper(), r.get("device", ""), r.get("command", ""), r.get("state", ""),
                       r.get("measure", ""), r.get("verdict") if r.get("verdict") in ("ok", "fail") else None,
                       r.get("model", ""), kind="info", key=r.get("key")))
        return out
    if t == "verify.result":
        obs = p.get("observed") or {}
        passed = bool(p.get("pass"))
        command = names.action(p.get("actionId")) or _op_summary((p.get("sent") or {}).get("op"))
        state = SENSE_STATE.get(obs.get("sense"), "SEEN")
        out.append(Row("SENT", names.card(p.get("cardId")), command, state, evidence_measure(obs, passed),
                       "ok" if passed else "fail", kind="oracle", key="ev:" + str(p.get("evidenceId"))))
    elif t == "agent.step":
        title = p.get("title") or ""
        verb = PHASE_VERB.get(p.get("phase"), "STEP")
        low = title.lower()
        if "captured" in low or low.startswith("learn"):
            verb = "LEARN"
        measure = p.get("evidence") or ""
        if not measure and p.get("latencyMs") is not None and p.get("status") in ("ok", "fail"):
            measure = "%.1f s" % (float(p["latencyMs"]) / 1000.0)
        model = p.get("model") or ""
        if p.get("source") == "fixture" and model:
            model += " (replay)"
        out.append(Row(verb, names.card(p.get("cardId")), title, STEP_STATE.get(p.get("status"), p.get("status", "")),
                       measure, None, model, kind="step", key="st:" + str(p.get("stepId"))))
    elif t == "link.result":
        v = p.get("verdict")
        ev = [e for e in (p.get("evidence") or []) if isinstance(e, dict)]
        detail = ev[0].get("detail", "") if ev else (p.get("reason") or "")
        port = (p.get("port") or {}).get("name") or p.get("channel") or ""
        if v == "mismatch":
            out.append(Row("REFUSED", names.card(p.get("cardId")), detail or port, "wrong device", "", "fail", kind="oracle",
                           key="lk:" + str(p.get("linkId"))))
        elif v in ("confirmed", "consistent"):
            out.append(Row("LINK", names.card(p.get("cardId")), port, "WIRED" if v == "confirmed" else "consistent", detail,
                           "ok" if v == "confirmed" else None, kind="oracle", key="lk:" + str(p.get("linkId"))))
        else:
            out.append(Row("LINK", names.card(p.get("cardId")), port, v or "unknown", detail, None, kind="info",
                           key="lk:" + str(p.get("linkId"))))
    elif t == "link.request":
        needs = ", ".join(p.get("needs") or [])
        sugg = ", ".join(p.get("suggestedClients") or [])
        out.append(Row("LINK", names.card(p.get("cardId")), "needs " + needs, (p.get("status") or "").replace("-", " "),
                       sugg, None, kind="warn", key="lr:" + str(p.get("linkId"))))
    elif t == "target.status":
        ms = TARGET_MILESTONES.get(p.get("state"))
        if ms:
            out.append(Row(ms[0], names.card(p.get("cardId")), p.get("detail") or "", ms[1], "", None, kind="info",
                           key="ts:%s:%s" % (p.get("cardId"), p.get("state"))))
    elif t == "ui.partial" and isinstance(p.get("hack"), dict):
        h = p["hack"]
        out.append(Row("FORGE", names.card(p.get("cardId")), h.get("name") or h.get("id", ""), "drafted", h.get("kind") or "",
                       None, kind="info", key="up:%s:%s" % (p.get("cardId"), h.get("id"))))
    elif t == "ui.spec":
        n = len(((p.get("hackset") or {}).get("hacks")) or p.get("widgets") or [])
        out.append(Row("FORGE", names.card(p.get("cardId")) or p.get("title", ""), "%d hacks" % n, "ready", "rev %s" % p.get("rev", 1),
                       None, p.get("modelId") or "", kind="info", key="us:%s:%s" % (p.get("specId"), p.get("rev"))))
    elif t == "device.card":
        mm = " ".join(x for x in (p.get("maker"), p.get("model")) if x)
        out.append(Row("IDENTIFY", names.card(p.get("cardId")) or p.get("name", ""), mm, "identified", "", None, kind="info",
                       key="dc:" + str(p.get("cardId"))))
    elif t == "driver.status":
        acts = p.get("actions") or []
        ver = sum(1 for a in acts if isinstance(a, dict) and a.get("verified") == "pass")
        measure = ("%d/%d verified" % (ver, len(acts))) if acts else ""
        out.append(Row("DRIVER", names.card(p.get("cardId")), p.get("driverId", ""), p.get("phase") or p.get("status") or "",
                       measure, None, p.get("modelId", ""), kind="info", key="ds:" + str(p.get("driverId"))))
    elif t == "arm.request":
        out.append(Row("ARM", names.card(p.get("cardId")), p.get("title", ""), "awaiting you", "", None, kind="warn", key="arm:" + str(p.get("armId"))))
    elif t == "arm.result":
        out.append(Row("ARM", names.card(p.get("cardId")), p.get("by") or "", "armed" if p.get("armed") else "not armed",
                       p.get("reason") or "", None, kind="info", key="arm:" + str(p.get("armId"))))
    elif t == "panic":
        out.append(Row("PANIC", names.card(p.get("cardId")) or "all", p.get("reason") or "stop everything", "stopped", "", None, kind="warn"))
    elif t == "voice.text" and p.get("final"):
        out.append(Row("VOICE", names.card(p.get("cardId")), '"%s"' % (p.get("text") or "")[:60], p.get("intent") or "heard", "",
                       None, p.get("modelId", ""), kind="info", key="vt:" + str(p.get("utteranceId") or m.get("id"))))
    elif t == "presence":
        reason = p.get("reason")
        did = p.get("deviceId")
        if did and reason in ("join", "leave", "paired", "revoked") and did != names.me:
            dev = None
            for d in p.get("devices") or []:
                if isinstance(d, dict) and d.get("deviceId") == did:
                    dev = d
            if dev:
                state = {"join": "online", "leave": "offline", "paired": "paired", "revoked": "revoked"}[reason]
                out.append(Row("PING", dev.get("name", did), dev.get("kind", ""), state, ", ".join(dev.get("capabilities") or [])[:14],
                               None, kind="info"))
    elif t == "log" and p.get("level") in ("warn", "error"):
        out.append(Row("LOG", "hub", p.get("code") or p.get("level"), p.get("level"), p.get("message", "")[:60], None, kind="warn"))
    return out
