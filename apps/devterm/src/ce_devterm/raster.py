"""1-bit raster images for the thermal printer (and their PNG previews on a Mac).

A Bitmap stores one byte per pixel (1 = ink) because that keeps drawing code simple and the images are
small (384 dots wide). `pack_rows()` produces the printer's format: MSB = leftmost dot, set bit = black.
"""
import struct
import zlib

from . import font

PAPER_DOTS = 384  # 58 mm DevTerm printer: 384 dots per line at 203 dpi (MAX_DOTS in ClockworkPi's daemon)


class Bitmap(object):
    __slots__ = ("width", "height", "rows")

    def __init__(self, width, height):
        if width <= 0 or height < 0:
            raise ValueError("bad bitmap size %dx%d" % (width, height))
        self.width = width
        self.height = height
        self.rows = [bytearray(width) for _ in range(height)]

    def set(self, x, y, value=1):
        if 0 <= x < self.width and 0 <= y < self.height:
            self.rows[y][x] = 1 if value else 0

    def get(self, x, y):
        if 0 <= x < self.width and 0 <= y < self.height:
            return self.rows[y][x]
        return 0

    def fill_rect(self, x, y, w, h, value=1):
        v = 1 if value else 0
        x0, x1 = max(0, x), min(self.width, x + w)
        if x1 <= x0:
            return
        for yy in range(max(0, y), min(self.height, y + h)):
            row = self.rows[yy]
            row[x0:x1] = bytes([v]) * (x1 - x0)

    def blit(self, other, x, y):
        """OR another bitmap onto this one at (x, y)."""
        for oy in range(other.height):
            ty = y + oy
            if not 0 <= ty < self.height:
                continue
            src = other.rows[oy]
            dst = self.rows[ty]
            for ox in range(other.width):
                if src[ox]:
                    tx = x + ox
                    if 0 <= tx < self.width:
                        dst[tx] = 1

    def ink(self):
        """Number of inked pixels (used to keep receipts from being solid black)."""
        return sum(sum(r) for r in self.rows)

    def pack_rows(self):
        """Rows packed 8 dots per byte, MSB first, 1 = ink. Width is padded to a multiple of 8."""
        nbytes = (self.width + 7) // 8
        out = []
        for row in self.rows:
            packed = bytearray(nbytes)
            for x in range(self.width):
                if row[x]:
                    packed[x >> 3] |= 0x80 >> (x & 7)
            out.append(bytes(packed))
        return out

    def to_png(self, scale=1, margin=0):
        """Encode as a 1-bit grayscale PNG (ink = black on white paper)."""
        scale = max(1, int(scale))
        w = (self.width + 2 * margin) * scale
        h = (self.height + 2 * margin) * scale
        nbytes = (w + 7) // 8
        raw = bytearray()
        blank = bytes([0xFF]) * nbytes
        for y in range(h):
            sy = y // scale - margin
            raw.append(0)  # filter type: none
            if not 0 <= sy < self.height:
                raw.extend(blank)
                continue
            src = self.rows[sy]
            packed = bytearray(blank)
            for x in range(w):
                sx = x // scale - margin
                if 0 <= sx < self.width and src[sx]:
                    packed[x >> 3] &= ~(0x80 >> (x & 7)) & 0xFF
            raw.extend(packed)

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        ihdr = struct.pack(">IIBBBBB", w, h, 1, 0, 0, 0, 0)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def vstack(parts, width=PAPER_DOTS):
    """Stack bitmaps vertically (left-aligned) into one bitmap `width` dots wide."""
    total = sum(p.height for p in parts)
    out = Bitmap(width, total)
    y = 0
    for p in parts:
        out.blit(p, 0, y)
        y += p.height
    return out


# ---- text -----------------------------------------------------------------------------------------

def advance(scale=2, spacing=1):
    """Horizontal dots per character cell."""
    return (font.WIDTH + spacing) * scale


def text_width(text, scale=2, spacing=1):
    if not text:
        return 0
    return len(text) * advance(scale, spacing) - spacing * scale


def columns(width=PAPER_DOTS, scale=2, spacing=1):
    """How many characters fit on one line."""
    return (width + spacing * scale) // advance(scale, spacing)


def line_height(scale=2, gap=2):
    return (font.HEIGHT + gap) * scale


def draw_text(bm, x, y, text, scale=2, spacing=1, bold=False):
    """Draw one line of text with its top-left cell corner at (x, y). Returns the width drawn."""
    cx = x
    step = advance(scale, spacing)
    for ch in text:
        g = font.glyph(ch)
        for gy in range(font.HEIGHT):
            grow = g[gy]
            for gx in range(font.WIDTH):
                if grow[gx]:
                    bm.fill_rect(cx + gx * scale, y + gy * scale, scale + (1 if bold else 0), scale, 1)
        cx += step
    return cx - x - spacing * scale if text else 0


def text_bitmap(text, scale=2, align="left", width=PAPER_DOTS, bold=False, gap=2, invert=False):
    """One line of text as a full-width bitmap strip."""
    h = line_height(scale, gap)
    bm = Bitmap(width, h)
    w = text_width(text, scale)
    if align == "center":
        x = max(0, (width - w) // 2)
    elif align == "right":
        x = max(0, width - w)
    else:
        x = 0
    top = (gap * scale) // 2
    if invert:
        bm.fill_rect(0, 0, width, h, 1)
        tmp = Bitmap(width, h)
        draw_text(tmp, x, top, text, scale=scale, bold=bold)
        for yy in range(h):
            r, t = bm.rows[yy], tmp.rows[yy]
            for xx in range(width):
                if t[xx]:
                    r[xx] = 0
    else:
        draw_text(bm, x, top, text, scale=scale, bold=bold)
    return bm


def wrap(text, cols):
    """Greedy word wrap to `cols` characters; long words are split. Keeps explicit newlines."""
    out = []
    for para in (text or "").split("\n"):
        words = para.split(" ")
        line = ""
        for word in words:
            while len(word) > cols:
                if line:
                    out.append(line)
                    line = ""
                out.append(word[:cols])
                word = word[cols:]
            if not line:
                line = word
            elif len(line) + 1 + len(word) <= cols:
                line += " " + word
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


# ---- rules, QR codes, contours --------------------------------------------------------------------

def rule_bitmap(width=PAPER_DOTS, dashed=True, thickness=2, pad=6, dash=8, gap=6):
    bm = Bitmap(width, pad * 2 + thickness)
    if dashed:
        x = 0
        while x < width:
            bm.fill_rect(x, pad, min(dash, width - x), thickness)
            x += dash + gap
    else:
        bm.fill_rect(0, pad, width, thickness)
    return bm


def qr_bitmap(matrix, width=PAPER_DOTS, max_module=8, quiet=4, pad=4):
    """A QR matrix (list of rows of bools) centred on a strip, as large as fits (<= max_module dots)."""
    n = len(matrix)
    module = max(1, min(max_module, width // (n + 2 * quiet)))
    side = (n + 2 * quiet) * module
    bm = Bitmap(width, side + 2 * pad)
    x0 = (width - side) // 2 + quiet * module
    y0 = pad + quiet * module
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                bm.fill_rect(x0 + x * module, y0 + y * module, module, module)
    return bm


def contour_bitmap(points, width=PAPER_DOTS, height=120, thickness=2):
    """A device silhouette from normalised [x, y] points (0..1, closed polyline), centred."""
    pts = [(float(p[0]), float(p[1])) for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
    bm = Bitmap(width, height)
    if len(pts) < 3:
        return bm
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    span = max(maxx - minx, maxy - miny, 1e-6)
    box = min(width, height) - 8
    sx = box / span
    ox = (width - (maxx - minx) * sx) / 2.0
    oy = (height - (maxy - miny) * sx) / 2.0

    def tp(p):
        return (int(round(ox + (p[0] - minx) * sx)), int(round(oy + (p[1] - miny) * sx)))

    for i in range(len(pts)):
        a, b = tp(pts[i]), tp(pts[(i + 1) % len(pts)])
        steps = max(abs(b[0] - a[0]), abs(b[1] - a[1]), 1)
        for s in range(steps + 1):
            x = a[0] + (b[0] - a[0]) * s // steps
            y = a[1] + (b[1] - a[1]) * s // steps
            bm.fill_rect(x - thickness // 2, y - thickness // 2, thickness, thickness)
    return bm


def blank(height, width=PAPER_DOTS):
    return Bitmap(width, max(0, height))
