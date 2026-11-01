#!/usr/bin/env python3
"""Build dist/ce-devterm.pyz: a dependency-free zipapp for Python 3.7+ (the DevTerm CM3's Buster image).

Reproducible: sorted entries with a fixed timestamp, so the same sources give the same SHA-256.
Also writes dist/SHA256SUMS. Run: python3 apps/devterm/scripts/build.py
"""
import hashlib
import os
import stat
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, "ce-devterm.pyz")
SHEBANG = b"#!/usr/bin/env python3\n"
EPOCH = (1980, 1, 1, 0, 0, 0)


def sources():
    out = []
    for base, dirs, files in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__" and not d.startswith("."))
        for f in sorted(files):
            if f.endswith(".py") or f.endswith(".txt"):
                full = os.path.join(base, f)
                out.append((os.path.relpath(full, SRC).replace(os.sep, "/"), full))
    return sorted(out)


def build():
    os.makedirs(DIST, exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "wb") as f:
        f.write(SHEBANG)
        with zipfile.ZipFile(f, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for arc, full in sources():
                info = zipfile.ZipInfo(arc, date_time=EPOCH)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                with open(full, "rb") as src:
                    z.writestr(info, src.read())
    os.chmod(tmp, 0o755)
    os.replace(tmp, OUT)
    digest = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    with open(os.path.join(DIST, "SHA256SUMS"), "w") as f:
        f.write("%s  ce-devterm.pyz\n" % digest)
    return digest


def main():
    digest = build()
    size = os.path.getsize(OUT)
    print("built %s (%d bytes, %d files)" % (os.path.relpath(OUT, os.getcwd()), size, len(sources())))
    print("sha256 %s" % digest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
