"""Big terminal lettering from the bitmap font (the passcode, the Show word hack)."""
from . import font

FULL = "█"


def render(text, wide=True, ascii_only=False, spacing=1):
    """Lines of big text. wide=True draws each font pixel as two cells (looks square on a terminal)."""
    on = "#" if ascii_only else FULL
    px = 2 if wide else 1
    rows = []
    height = 7  # caps and digits: the descender rows stay empty
    for gy in range(height):
        parts = []
        for ch in text:
            g = font.glyph(ch)
            parts.append("".join((on * px) if g[gy][gx] else (" " * px) for gx in range(font.WIDTH)))
        rows.append((" " * (spacing * px)).join(parts))
    return rows


def width(text, wide=True, spacing=1):
    px = 2 if wide else 1
    if not text:
        return 0
    return len(text) * font.WIDTH * px + (len(text) - 1) * spacing * px


def fit(text, max_cols, ascii_only=False):
    """The largest rendering of `text` that fits `max_cols` columns, or None if even the small one does not."""
    if width(text, wide=True) <= max_cols:
        return render(text, wide=True, ascii_only=ascii_only)
    if width(text, wide=False) <= max_cols:
        return render(text, wide=False, ascii_only=ascii_only)
    return None
