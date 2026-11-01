"""Colours and glyphs for the terminal, from the HUD tokens.

    cyan    perception, links, idle        volt   selected, progress, values
    magenta daemons, power                 ok/fail ONLY oracle verdicts (seen / heard / wired)
    dim     secondary text                 bone   primary text            background: black

16-colour terminals get the ANSI bright map (96 93 95 92 91 90 97), 256-colour terminals the closest
xterm colours, 8-colour terminals base colours + bold, monochrome terminals bold/reverse. Nothing ever
uses the blink attribute (nothing changes faster than 1 Hz on any screen).
"""
import curses
import locale

# token: (256-colour index, 16-colour index, 8-colour base, bold on 8-colour)
PALETTE = {
    "bone": (255, 15, curses.COLOR_WHITE, True),
    "dim": (246, 8, curses.COLOR_WHITE, False),
    "cyan": (87, 14, curses.COLOR_CYAN, True),
    "volt": (227, 11, curses.COLOR_YELLOW, True),
    "magenta": (205, 13, curses.COLOR_MAGENTA, True),
    "ok": (85, 10, curses.COLOR_GREEN, True),
    "fail": (203, 9, curses.COLOR_RED, True),
}
ORDER = ["bone", "dim", "cyan", "volt", "magenta", "ok", "fail"]

ANSI = {"bone": "97", "dim": "90", "cyan": "96", "volt": "93", "magenta": "95", "ok": "92", "fail": "91"}

# xterm-256 colours for screen washes (nearest-colour lookup)
_CUBE = [0, 95, 135, 175, 215, 255]


def unicode_ok():
    enc = (locale.getpreferredencoding(False) or "").lower().replace("-", "")
    return "utf8" in enc


class Glyphs(object):
    def __init__(self, uni=True):
        self.unicode = uni
        self.action = ">"
        self.control = "(o)"
        self.daemon = "oo"
        self.ok = "✓" if uni else "OK"
        self.fail = "✗" if uni else "NO"
        self.proven = "───" if uni else "---"
        self.hypothesis = "- -"
        self.h = "─" if uni else "-"
        self.v = "│" if uni else "|"
        self.tl, self.tr, self.bl, self.br = ("╭", "╮", "╰", "╯") if uni else ("+", "+", "+", "+")
        self.full = "█" if uni else "#"
        self.empty = "░" if uni else "."
        self.eighths = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] if uni else [""] * 8
        self.upper = "▀"
        self.lower = "▄"
        self.sel = "›" if uni else ">"
        self.dot = "·" if uni else "."
        self.ellipsis = "…" if uni else "..."

    def kind(self, kind):
        if kind == "action":
            return self.action
        if kind == "daemon":
            return self.daemon
        return self.control

    def bar(self, fraction, width):
        """Value bar with eighth-block precision: (filled, partial, empty) strings."""
        width = max(1, width)
        fraction = max(0.0, min(1.0, fraction))
        total = fraction * width
        full = int(total)
        rem = int((total - full) * 8)
        partial = self.eighths[rem] if (rem and full < width) else ""
        empty = width - full - (1 if partial else 0)
        return self.full * full, partial, self.empty * empty


class Theme(object):
    """Curses attributes per token. Call after curses.initscr()/start_color()."""

    PAIR_BASE = 1

    def __init__(self, mono=False, uni=None):
        self.glyphs = Glyphs(unicode_ok() if uni is None else uni)
        self.attrs = {}
        self.colors = 0
        self.mono = mono or not curses.has_colors()
        self.qr_light = curses.A_REVERSE
        self.qr_dark = curses.A_NORMAL
        self.selected = curses.A_REVERSE
        self._wash_pair = None
        if self.mono:
            for t in ORDER:
                self.attrs[t] = curses.A_BOLD if t in ("volt", "ok", "fail", "bone") else curses.A_NORMAL
            self.attrs["dim"] = curses.A_DIM
            return
        curses.start_color()
        self.colors = curses.COLORS
        bg = curses.COLOR_BLACK
        for i, t in enumerate(ORDER):
            c256, c16, c8, bold8 = PALETTE[t]
            if self.colors >= 256:
                fg, extra = c256, 0
            elif self.colors >= 16:
                fg, extra = c16, 0
            else:
                fg, extra = c8, (curses.A_BOLD if bold8 else 0)
                if t == "dim":
                    extra = curses.A_DIM
            curses.init_pair(self.PAIR_BASE + i, fg, bg)
            self.attrs[t] = curses.color_pair(self.PAIR_BASE + i) | extra
        white = 15 if self.colors >= 16 else curses.COLOR_WHITE
        n = self.PAIR_BASE + len(ORDER)
        curses.init_pair(n, curses.COLOR_BLACK, white)  # QR light modules / '▀▄' halves
        self.qr_light = curses.color_pair(n)
        curses.init_pair(n + 1, white, curses.COLOR_BLACK)  # QR dark modules
        self.qr_dark = curses.color_pair(n + 1)
        sel_bg = 227 if self.colors >= 256 else (11 if self.colors >= 16 else curses.COLOR_YELLOW)
        curses.init_pair(n + 2, curses.COLOR_BLACK, sel_bg)  # selected row: black on volt
        self.selected = curses.color_pair(n + 2)
        self._wash_pair = n + 3

    def __getitem__(self, token):
        return self.attrs.get(token, curses.A_NORMAL)

    def wash(self, hex_color):
        """A background attribute for a screen wash in (roughly) that colour."""
        if self.mono or self._wash_pair is None:
            return curses.A_REVERSE
        idx = nearest_color(hex_color, self.colors)
        fg = curses.COLOR_BLACK if _luma(hex_color) > 0.5 else (15 if self.colors >= 16 else curses.COLOR_WHITE)
        try:
            curses.init_pair(self._wash_pair, fg, idx)
        except curses.error:
            return curses.A_REVERSE
        return curses.color_pair(self._wash_pair)


def _rgb(hex_color):
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (255, 255, 255)


def _luma(hex_color):
    r, g, b = _rgb(hex_color)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def nearest_color(hex_color, colors):
    r, g, b = _rgb(hex_color)
    if colors >= 256:
        def q(v):
            return min(range(6), key=lambda i: abs(_CUBE[i] - v))
        return 16 + 36 * q(r) + 6 * q(g) + q(b)
    base = [(0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229)]
    bright = [(127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
    table = base + (bright if colors >= 16 else [])
    return min(range(len(table)), key=lambda i: sum((a - b) ** 2 for a, b in zip(table[i], (r, g, b))))


def ansi(token, text, enabled=True):
    if not enabled:
        return text
    return "\x1b[%sm%s\x1b[0m" % (ANSI.get(token, "0"), text)
