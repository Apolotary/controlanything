"""Thermal receipts: a list of blocks that render both to 384-dot raster strips (paper, PNG preview)
and to plain terminal lines (the TUI preview). Layouts follow the 32-column receipt language:
title in caps, time, device · hack, oracle · result, model ids, a dashed rule.
"""
import time

from . import font, qr, raster

COLS = raster.columns(scale=2)  # 32 characters per line at the body size
MAX_HEIGHT_DOTS = 2400  # ~30 cm of paper; longer receipts are cut with a note


def _clean(text, limit=400):
    """Printable text only: no control characters, bounded length."""
    s = "".join(ch if (ch == "\n" or ord(ch) >= 32) and ch != "\x7f" else " " for ch in str(text or ""))
    return s[:limit]


class Block(object):
    kind = "block"

    def bitmaps(self, unicode_ok=False):
        raise NotImplementedError

    def preview(self, cols):
        """[(style, text)] lines for the terminal; style in title|text|dim|rule|qr|big."""
        raise NotImplementedError

    def segments(self, unicode_ok=False):
        """Printer segments: ('raster', Bitmap) or ('text', str, align)."""
        return [("raster", b) for b in self.bitmaps(unicode_ok)]


class Title(Block):
    kind = "title"

    def __init__(self, text, scale=3):
        self.text = _clean(text, 64).upper()
        self.scale = scale

    def _lines(self):
        return raster.wrap(self.text, raster.columns(scale=self.scale))

    def bitmaps(self, unicode_ok=False):
        return [raster.text_bitmap(line, scale=self.scale, align="center", bold=True) for line in self._lines()]

    def preview(self, cols):
        return [("title", line.center(cols)) for line in self._lines()]


class Text(Block):
    kind = "text"

    def __init__(self, text, align="left", bold=False, style="text", scale=2):
        self.text = _clean(text)
        self.align = align
        self.bold = bold
        self.style = style
        self.scale = scale

    def lines(self):
        return raster.wrap(self.text, raster.columns(scale=self.scale))

    def bitmaps(self, unicode_ok=False):
        return [raster.text_bitmap(line, scale=self.scale, align=self.align, bold=self.bold) for line in self.lines()]

    def segments(self, unicode_ok=False):
        out = []
        for line in self.lines():
            if unicode_ok and not font.all_supported(line):
                out.append(("text", line, self.align))  # e.g. Japanese button labels, via the daemon's TTF font
            elif not unicode_ok and line.strip() and not any(font.supported(ch) for ch in line if not ch.isspace()):
                continue  # nothing printable without a TTF (a Japanese-only label): leave it off the paper
            else:
                out.append(("raster", raster.text_bitmap(line, scale=self.scale, align=self.align, bold=self.bold)))
        return out

    def preview(self, cols):
        out = []
        for line in self.lines():
            if self.align == "center":
                line = line.center(cols)
            elif self.align == "right":
                line = line.rjust(cols)
            out.append((self.style, line))
        return out


class Rule(Block):
    kind = "rule"

    def __init__(self, dashed=True):
        self.dashed = dashed

    def bitmaps(self, unicode_ok=False):
        return [raster.rule_bitmap(dashed=self.dashed)]

    def preview(self, cols):
        return [("rule", ("- " * cols)[:cols] if self.dashed else "─" * cols)]


class Qr(Block):
    kind = "qr"

    def __init__(self, data, ecc="M", max_module=8):
        self.data = str(data)[:512]
        self.matrix = qr.matrix(self.data, ecc)
        self.max_module = max_module

    def bitmaps(self, unicode_ok=False):
        return [raster.qr_bitmap(self.matrix, max_module=self.max_module)]

    def preview(self, cols):
        lines = qr.lines_unicode(self.matrix, quiet=1)
        pad = max(0, (cols - len(lines[0])) // 2) if lines else 0
        return [("qr", " " * pad + line) for line in lines]


class Big(Block):
    kind = "big"

    def __init__(self, text, scale=7):
        self.text = _clean(text, 16).upper()
        self.scale = scale

    def bitmaps(self, unicode_ok=False):
        scale = self.scale
        while scale > 2 and raster.text_width(self.text, scale) > raster.PAPER_DOTS - 16:
            scale -= 1
        return [raster.text_bitmap(self.text, scale=scale, align="center", bold=False, gap=2)]

    def preview(self, cols):
        from . import bigtext
        rows = bigtext.fit(self.text, cols) or [self.text]
        return [("big", r.center(cols)) for r in rows]


class Contour(Block):
    kind = "contour"

    def __init__(self, points, height=120):
        self.points = points
        self.height = height

    def bitmaps(self, unicode_ok=False):
        return [raster.contour_bitmap(self.points, height=self.height)]

    def preview(self, cols):
        return [("dim", "[device outline]".center(cols))]


class Space(Block):
    kind = "space"

    def __init__(self, dots=12):
        self.dots = dots

    def bitmaps(self, unicode_ok=False):
        return [raster.blank(self.dots)]

    def preview(self, cols):
        return [("text", "")] if self.dots >= 16 else []


class Receipt(object):
    """An ordered list of blocks plus a tag used in file names."""

    def __init__(self, tag="receipt", blocks=None):
        self.tag = tag
        self.blocks = list(blocks or [])

    def add(self, block):
        self.blocks.append(block)
        return self

    def segments(self, unicode_ok=False, max_height=MAX_HEIGHT_DOTS):
        """Printer segments with consecutive raster strips merged, cut at max_height dots."""
        out = []
        height = 0
        cut = False
        for b in self.blocks:
            for seg in b.segments(unicode_ok):
                h = seg[1].height if seg[0] == "raster" else 24
                if height + h > max_height:
                    cut = True
                    break
                height += h
                if seg[0] == "raster" and out and out[-1][0] == "raster":
                    out[-1] = ("raster", raster.vstack([out[-1][1], seg[1]]))
                else:
                    out.append(seg)
            if cut:
                break
        if cut:
            note = raster.text_bitmap("… cut at 30 cm", align="center")
            if out and out[-1][0] == "raster":
                out[-1] = ("raster", raster.vstack([out[-1][1], note]))
            else:
                out.append(("raster", note))
        return out

    def bitmap(self, max_height=MAX_HEIGHT_DOTS):
        """The whole receipt as one bitmap (what the paper shows when Unicode lines use the fallback font)."""
        strips = [s[1] for s in self.segments(unicode_ok=False, max_height=max_height) if s[0] == "raster"]
        return raster.vstack(strips) if strips else raster.blank(1)

    def preview(self, cols=COLS):
        out = []
        for b in self.blocks:
            out.extend(b.preview(cols))
        return out

    def text(self, cols=COLS):
        return "\n".join(line for _style, line in self.preview(cols)).rstrip() + "\n"


# ---- layouts --------------------------------------------------------------------------------------

def _stamp(ts=None):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts if ts is not None else time.time()))


def _verdict_glyph(v):
    if v in (True, "ok", "pass", "seen", "heard", "wired"):
        return "✓"
    if v in (False, "fail", "no", "none"):
        return "✗"
    return ""


def pairing_ticket(display_code, qr_url, device_name="DevTerm", server="", expires_at_ms=None, now=None):
    """The LINK REQUEST ticket: QR + passcode, so the Quest can look at the paper (or the code is typed)."""
    now = time.time() if now is None else now
    r = Receipt("link-request")
    r.add(Title("CONTROL ANYTHING"))
    r.add(Text("· LINK REQUEST ·", align="center", bold=True))
    r.add(Rule())
    if qr_url:
        r.add(Qr(qr_url, max_module=12))  # "CE1:<code>" is a 21-module QR: 12-dot modules read from across a room
    r.add(Big(display_code))
    r.add(Text("type this code on the Mac", align="center"))
    r.add(Text("or look at it from the headset", align="center"))
    r.add(Rule())
    r.add(Text("%s · devterm" % (device_name or "DevTerm")))
    exp = ""
    if expires_at_ms:
        left = expires_at_ms / 1000.0 - now
        if 0 < left < 3600:
            exp = " · valid %d min" % max(1, int(round(left / 60.0)))
    r.add(Text(_stamp(now)[:16] + exp, style="dim"))
    if server:
        r.add(Text(server, style="dim"))
    r.add(Space(8))
    return r


def _row_from_string(s):
    """"3|明るく|BRIGHTER|+38% lum|ok" -> {n, jp, label, measure, verdict} (LocalOp args are flat: strings only)."""
    parts = [p.strip() for p in str(s).split("|")]
    if len(parts) < 2:
        return str(s)
    parts += [""] * (5 - len(parts))
    return {"n": parts[0] or None, "jp": parts[1], "label": parts[2] or "?", "measure": parts[3], "verdict": parts[4] or None}


def _contour_points(c):
    """[[x, y], ...] (local), ["x,y", ...] or "x,y x,y ..." (protocol-flat) -> [(x, y), ...]."""
    if isinstance(c, str):
        c = c.replace(";", " ").split()
    pts = []
    for p in c or []:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            pts.append((p[0], p[1]))
        elif isinstance(p, str) and "," in p:
            try:
                x, y = p.split(",")[:2]
                pts.append((float(x), float(y)))
            except ValueError:
                continue
    return pts


def from_print_arg(arg, now=None, device_name=None):
    """Build a receipt from an exec.command `print` LocalOp argument.

    Accepts a string (the body) or a flat object (protocol LocalArgs: string | number | boolean | string[]):
      {title, lines[] | text, device, hack, oracle, verdict, measure, rows[], models[], qr, contour, footer}
    rows (learned codes on a LINK receipt): "n|jp|label|measure|verdict" strings, e.g. "3|明るく|BRIGHTER|+38% lum|ok"
      (dicts {n, jp, label, measure, verdict} work too when called locally)
    contour (the device silhouette, normalised 0..1): "x,y x,y ..." or ["x,y", ...]
    """
    now = time.time() if now is None else now
    if isinstance(arg, dict):
        a = arg
    elif arg is None:
        a = {}
    else:
        a = {"text": str(arg)}
    title = _clean(a.get("title") or "RECEIPT", 32)
    r = Receipt(tag=_slug(title))
    r.add(Title(title))
    r.add(Text(_stamp(now), align="center", style="dim"))
    r.add(Rule())
    dev = a.get("device")
    hack = a.get("hack")
    if dev or hack:
        r.add(Text(" · ".join(_clean(x, 40) for x in (dev, hack) if x), bold=True))
    oracle = a.get("oracle")
    if oracle:
        line = _clean(oracle, 60)
        if a.get("measure"):
            line += ": " + _clean(a.get("measure"), 24)
        g = _verdict_glyph(a.get("verdict"))
        r.add(Text(line + ((" " + g) if g else "")))
    body = a.get("lines")
    if body is None and a.get("text") is not None:
        body = str(a.get("text")).split("\n")
    for line in (body or [])[:40]:
        r.add(Text(_clean(line, 200)))
    rows = a.get("rows") or []
    if isinstance(rows, str):
        rows = [rows]
    if rows:
        r.add(Rule())
        for row in rows[:24]:
            if isinstance(row, str):
                row = _row_from_string(row)
            if not isinstance(row, dict):
                r.add(Text(_clean(row, 80)))
                continue
            n = row.get("n", row.get("capture"))
            head = ("#%s " % n) if n is not None else ""
            label = _clean(row.get("label") or "?", 16).upper()
            meas = _clean(row.get("measure") or "", 14)
            g = _verdict_glyph(row.get("verdict"))
            r.add(Text(("%s%s %s %s" % (head, label, meas, g)).strip()))
            if row.get("jp"):
                r.add(Text("   " + _clean(row.get("jp"), 24), style="dim"))
    pts = _contour_points(a.get("contour"))
    if len(pts) >= 3:
        r.add(Contour(pts))
    if a.get("qr"):
        r.add(Qr(a.get("qr")))
    models = a.get("models")
    if isinstance(models, str):
        models = [models]
    if models:
        r.add(Rule())
        r.add(Text(" · ".join(_clean(m, 40) for m in models[:6]), style="dim"))
    r.add(Rule())
    r.add(Text(_clean(a.get("footer") or ("%s · your own devices" % (device_name or "DevTerm")), 64), align="center", style="dim"))
    r.add(Space(8))
    return r


def test_receipt(device_name="DevTerm", now=None):
    """`ce-devterm print-test`: exercises text, symbols, a rule and a QR code."""
    return from_print_arg({
        "title": "PRINTER TEST",
        "device": device_name,
        "hack": "Print receipt",
        "oracle": "camera",
        "measure": "paper moved",
        "verdict": "ok",
        "lines": ["ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789", "abcdefghijklmnopqrstuvwxyz", "· ✓ ✗ → − … ∞ ° %#@&"],
        "models": ["muse-spark-1.3", "sam-3.1"],
        "qr": "https://github.com/",
    }, now=now, device_name=device_name)


def _slug(text):
    s = "".join(ch.lower() if ch.isalnum() else "-" for ch in text)
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")[:32] or "receipt"
