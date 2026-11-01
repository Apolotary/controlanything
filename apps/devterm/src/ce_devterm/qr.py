"""QR codes for the pairing screen (terminal) and the pairing ticket (thermal paper)."""
from .vendor.qrcodegen import QrCode

_ECC = {"L": QrCode.Ecc.LOW, "M": QrCode.Ecc.MEDIUM, "Q": QrCode.Ecc.QUARTILE, "H": QrCode.Ecc.HIGH}

UPPER = "▀"  # ▀
LOWER = "▄"  # ▄
FULL = "█"  # █


def matrix(text, ecc="M"):
    """The QR module matrix for `text`: a list of rows, True = dark."""
    q = QrCode.encode_text(text, _ECC.get(ecc, QrCode.Ecc.MEDIUM))
    n = q.get_size()
    return [[q.get_module(x, y) for x in range(n)] for y in range(n)]


def _padded(m, quiet):
    n = len(m)
    size = n + 2 * quiet
    out = [[False] * size for _ in range(size)]
    for y in range(n):
        out[y + quiet][quiet:quiet + n] = m[y]
    return out


def cells(m, quiet=2):
    """Half-block cells for a colour terminal: rows of (top_dark, bottom_dark) pairs.

    Two modules per character cell vertically, so a ~1:2 terminal cell becomes two square modules.
    """
    p = _padded(m, quiet)
    if len(p) % 2:
        p.append([False] * len(p[0]))
    rows = []
    for y in range(0, len(p), 2):
        rows.append([(p[y][x], p[y + 1][x]) for x in range(len(p[0]))])
    return rows


def lines_unicode(m, quiet=2):
    """Plain-text QR for a dark terminal without colours (the `qrencode -t UTF8` convention:
    block characters draw the LIGHT modules, so dark modules come out as the terminal background)."""
    out = []
    for row in cells(m, quiet):
        s = []
        for top, bottom in row:
            lt, lb = not top, not bottom
            s.append(FULL if (lt and lb) else UPPER if lt else LOWER if lb else " ")
        out.append("".join(s))
    return out


def lines_ansi(m, quiet=2):
    """QR forced to black-on-white with ANSI colours (scans on any terminal theme)."""
    out = []
    for row in cells(m, quiet):
        s = ["\x1b[97;40m"]  # fg bright white, bg black: '▀' paints the top half fg, bottom half bg
        for top, bottom in row:
            fg = "30" if top else "97"
            bg = "40" if bottom else "107"
            s.append("\x1b[%s;%sm%s" % (fg, bg, UPPER))
        s.append("\x1b[0m")
        out.append("".join(s))
    return out


def lines_ascii(m, quiet=2):
    """Two characters per module, '##' = dark; for terminals without Unicode (scans poorly, last resort)."""
    p = _padded(m, quiet)
    return ["".join("##" if v else "  " for v in row) for row in p]
