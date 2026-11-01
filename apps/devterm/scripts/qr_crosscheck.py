#!/usr/bin/env python3
"""Dev-only: compare the vendored QR encoder with the JS `qrcode` package, module for module.

Needs Node and the repo's node_modules (run from anywhere inside the repo checkout):

    python3 apps/devterm/scripts/qr_crosscheck.py

Forces byte mode, a fixed version and a fixed mask on both sides, so any difference is a real
encoding bug (RS blocks, interleaving, placement, format/version bits, masking).
"""
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from ce_devterm.vendor.qrcodegen import QrCode, QrSegment  # noqa: E402

ECLS = {"L": QrCode.Ecc.LOW, "M": QrCode.Ecc.MEDIUM, "Q": QrCode.Ecc.QUARTILE, "H": QrCode.Ecc.HIGH}


def python_rows(text, ecl, version, mask):
    seg = QrSegment.make_bytes(text.encode("utf-8"))
    qr = QrCode.encode_segments([seg], ECLS[ecl], minversion=version, maxversion=version, mask=mask, boostecl=False)
    n = qr.get_size()
    return ["".join("1" if qr.get_module(x, y) else "0" for x in range(n)) for y in range(n)]


def main():
    rnd = random.Random(1234)
    cases = []
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/#.-_?=&%"
    for version in list(range(1, 15)) + [20, 25, 32, 40]:
        for ecl in "LMQH":
            for mask in (0, 3, 5, 7):
                cap = QrCode._get_num_data_codewords(version, ECLS[ecl]) - (2 if version < 10 else 3)
                length = max(1, min(cap, rnd.randint(1, max(1, cap))))
                text = "".join(rnd.choice(alphabet) for _ in range(length))
                cases.append({"text": text, "ecl": ecl, "version": version, "mask": mask})
    cases.append({"text": "https://192.168.1.14:8443/p/AbC123xyZ9#K7Q4M2", "ecl": "M", "version": 4, "mask": 2})
    proc = subprocess.run(["node", os.path.join(HERE, "qr_crosscheck.cjs")], input=json.dumps(cases).encode(),
                          stdout=subprocess.PIPE, cwd=HERE, check=True)
    js = json.loads(proc.stdout.decode())
    bad = 0
    for case, other in zip(cases, js):
        mine = python_rows(case["text"], case["ecl"], case["version"], case["mask"])
        if mine != other["rows"]:
            bad += 1
            diff = sum(a != b for ra, rb in zip(mine, other["rows"]) for a, b in zip(ra, rb))
            print("MISMATCH v%d-%s mask %d (%d modules differ): %r" % (case["version"], case["ecl"], case["mask"], diff, case["text"][:40]))
    print("%d cases, %d mismatches" % (len(cases), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
