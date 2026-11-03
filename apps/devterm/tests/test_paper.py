import hashlib
import os
import shutil
import struct
import tempfile
import threading
import time
import unittest
import zlib

import helpers  # noqa: F401  (puts src on sys.path)

from ce_devterm import bigtext, font, printer, qr, raster, receipt
from ce_devterm.vendor.qrcodegen import QrCode, QrSegment


def matrix_digest(m):
    return hashlib.sha256("".join("1" if v else "0" for row in m for v in row).encode()).hexdigest()[:16]


class QrTest(unittest.TestCase):
    def test_structure(self):
        m = qr.matrix("https://192.168.1.14:8443/p/AbC123xyZ9#K7Q4M2")
        n = len(m)
        self.assertEqual(n, 33)  # version 4
        for (x, y) in ((0, 0), (n - 7, 0), (0, n - 7)):  # finder patterns: dark 7x7 border
            self.assertTrue(all(m[y][x + i] for i in range(7)))
            self.assertTrue(all(m[y + 6][x + i] for i in range(7)))
        self.assertEqual([m[6][x] for x in range(8, n - 8)], [x % 2 == 0 for x in range(8, n - 8)])  # timing
        self.assertTrue(m[n - 8][8])  # the always-dark module

    def test_fixed_vector_regression(self):
        # Same digest as the independent JS `qrcode` package for this input (byte mode, M, mask 3):
        # node -e "QRCode.create([{data: Buffer.from('ControlEverything'), mode: 'byte'}], {errorCorrectionLevel: 'M', maskPattern: 3})"
        q = QrCode.encode_segments([QrSegment.make_bytes(b"ControlEverything")], QrCode.Ecc.MEDIUM, mask=3, boostecl=False)
        m = [[q.get_module(x, y) for x in range(q.get_size())] for y in range(q.get_size())]
        self.assertEqual((q.get_version(), q.get_mask()), (2, 3))
        self.assertEqual(matrix_digest(m), "15c85bbae5d1958f")

    def test_capacity_and_modes(self):
        self.assertEqual(QrCode.encode_text("12345678901234567890", QrCode.Ecc.LOW).get_version(), 1)  # numeric
        self.assertEqual(QrCode.encode_text("HELLO WORLD", QrCode.Ecc.QUARTILE).get_version(), 1)  # alphanumeric
        self.assertEqual(QrCode.encode_binary(b"\x00" * 2953, QrCode.Ecc.LOW).get_version(), 40)
        with self.assertRaises(ValueError):
            QrCode.encode_binary(b"\x00" * 2954, QrCode.Ecc.LOW)

    def test_terminal_renderings(self):
        m = qr.matrix("x")
        cells = qr.cells(m, quiet=2)
        self.assertEqual(len(cells), (len(m) + 4 + 1) // 2)
        self.assertEqual(len(cells[0]), len(m) + 4)
        uni = qr.lines_unicode(m)
        self.assertEqual(uni[0], qr.FULL * (len(m) + 4))  # quiet zone = light = block on a dark terminal
        ansi = qr.lines_ansi(m)
        self.assertTrue(ansi[0].startswith("\x1b["))
        self.assertEqual(len(qr.lines_ascii(m)[0]), 2 * (len(m) + 4))


class FontRasterTest(unittest.TestCase):
    def test_font_covers_printable_ascii_and_hud_symbols(self):
        for code in range(32, 127):
            self.assertTrue(font.supported(chr(code)), repr(chr(code)))
        for ch in "·✓✗→−…∞—’":
            self.assertTrue(font.supported(ch), repr(ch))
        self.assertFalse(font.supported("全"))
        for ch, g in font.GLYPHS.items():
            self.assertEqual(len(g), font.HEIGHT)
            self.assertTrue(all(len(r) == font.WIDTH for r in g))

    def test_32_columns_on_384_dots(self):
        self.assertEqual(raster.columns(scale=2), 32)
        self.assertLessEqual(raster.text_width("x" * 32, 2), raster.PAPER_DOTS)
        bm = raster.text_bitmap("A", scale=2)
        self.assertEqual(bm.width, 384)
        self.assertGreater(bm.ink(), 0)

    def test_pack_rows_msb_first(self):
        bm = raster.Bitmap(16, 1)
        bm.set(0, 0)
        bm.set(9, 0)
        self.assertEqual(bm.pack_rows(), [bytes([0x80, 0x40])])

    def test_png_is_valid(self):
        bm = raster.Bitmap(10, 3)
        bm.fill_rect(0, 0, 10, 1)
        png = bm.to_png()
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        w, h, depth, ctype = struct.unpack(">IIBB", png[16:26])
        self.assertEqual((w, h, depth, ctype), (10, 3, 1, 0))
        idat_len = struct.unpack(">I", png[33:37])[0]
        raw = zlib.decompress(png[41:41 + idat_len])
        self.assertEqual(raw[0:3], b"\x00\x00\x3f")  # filter 0, then black (0 bits) for the 10 inked pixels
        self.assertEqual(raw[3:6], b"\x00\xff\xff")  # the next row is white

    def test_wrap(self):
        self.assertEqual(raster.wrap("one two three", 7), ["one two", "three"])
        self.assertEqual(raster.wrap("abcdefghij", 4), ["abcd", "efgh", "ij"])
        self.assertEqual(raster.wrap("a\nb", 10), ["a", "b"])

    def test_bigtext(self):
        rows = bigtext.render("K7Q-4M2")
        self.assertEqual(len(rows), 7)
        self.assertEqual(len(rows[0]), bigtext.width("K7Q-4M2"))
        self.assertIsNone(bigtext.fit("K7Q-4M2", 10))
        self.assertEqual(len(bigtext.fit("K7Q-4M2", 50)[0]), bigtext.width("K7Q-4M2", wide=False))


class ReceiptTest(unittest.TestCase):
    def test_pairing_ticket_has_the_brief_lines(self):
        r = receipt.pairing_ticket("K7Q-4M2", "https://mac:8443/p/x#K7Q4M2", "DevTerm", "mac:8787", (time.time() + 300) * 1000)
        text = r.text()
        self.assertIn("CONTROL ANYTHING", text)
        self.assertIn("LINK REQUEST", text)
        self.assertIn("K7Q-4M2", text)
        self.assertIn("type this code on the Mac", text)
        kinds = [b.kind for b in r.blocks]
        self.assertIn("qr", kinds)
        self.assertIn("big", kinds)
        bm = r.bitmap()
        self.assertEqual(bm.width, 384)
        self.assertLess(bm.height, 900)

    def test_print_arg_receipt_32_columns(self):
        r = receipt.from_print_arg({"title": "blackout", "device": "light", "hack": "Lights off", "oracle": "camera",
                                    "measure": "-38% lum", "verdict": "ok", "models": ["muse-spark-1.3", "sam-3.1"],
                                    "lines": ["x" * 80]})
        lines = [l for _s, l in r.preview()]
        self.assertTrue(all(len(l) <= 32 for l in lines), lines)
        self.assertIn("BLACKOUT", r.text())
        self.assertIn("camera: -38% lum ✓", r.text())
        self.assertIn("muse-spark-1.3 · sam-3.1", r.text())

    def test_plain_string_and_control_chars(self):
        r = receipt.from_print_arg("hello\x1b@\x00world")
        self.assertNotIn("\x1b", r.text())
        self.assertIn("hello", r.text())

    def test_unicode_lines_go_to_the_ttf_only_when_available(self):
        r = receipt.from_print_arg({"rows": [{"n": 2, "jp": "明るく", "label": "brighter", "measure": "+38% lum", "verdict": "ok"}]})
        segs_ttf = r.segments(unicode_ok=True)
        self.assertTrue(any(s[0] == "text" and "明" in s[1] for s in segs_ttf))
        segs_plain = r.segments(unicode_ok=False)
        self.assertTrue(all(s[0] == "raster" for s in segs_plain))

    def test_link_receipt_from_protocol_flat_args(self):
        # LocalArgs only allow string | number | boolean | string[]: rows and contour travel as strings
        arg = {"title": "LINK VERIFIED", "device": "light", "hack": "Learn remote",
               "rows": ["1|全灯|FULL|+61% lum|ok", "2|明るく|BRIGHTER|+38% lum|ok", "3||?|no change|fail"],
               "contour": "0.1,0.1 0.9,0.1 0.9,0.6 0.1,0.6", "models": ["muse-spark-1.3", "sam-3.1"]}
        r = receipt.from_print_arg(arg)
        text = r.text()
        self.assertIn("#1 FULL +61% lum ✓", text)
        self.assertIn("#3 ? no change ✗", text)
        self.assertIn("明るく", text)
        self.assertIn("contour", [b.kind for b in r.blocks])
        self.assertGreater(r.bitmap().height, 300)

    def test_height_cap(self):
        r = receipt.from_print_arg({"lines": ["line %d" % i for i in range(40)], "rows": [{"n": i, "label": "x"} for i in range(24)]})
        bm = r.bitmap(max_height=600)
        self.assertLessEqual(bm.height, 600 + raster.line_height())


class PrinterTest(unittest.TestCase):
    def test_escpos_stream(self):
        bm = raster.Bitmap(384, 1300)
        bm.fill_rect(0, 0, 1, 1300)
        job = printer.encode_job([("raster", bm)], density=6, feed_dots=300)
        self.assertTrue(job.startswith(b"\x1b@\x12#\x06\x1ba\x00"))
        # 1300 rows -> strips of 600, 600, 100 (each GS v 0 image stays below 64 KiB)
        heads = []
        i = job.find(b"\x1dv0")
        while i >= 0:
            heads.append(job[i:i + 8])
            i = job.find(b"\x1dv0", i + 8 + 48)
        self.assertEqual([h[4] for h in heads], [48, 48, 48])
        self.assertEqual([h[6] + 256 * h[7] for h in heads], [600, 600, 100])
        first_row = job[job.find(b"\x1dv0") + 8:][:48]
        self.assertEqual(first_row, b"\x80" + b"\x00" * 47)
        self.assertTrue(job.endswith(b"\x1bJ\xff\x1bJ\x2d"))  # 300 dots of feed, ESC J takes <= 255

    def test_unicode_text_segment(self):
        job = printer.encode_job([("text", "全灯", "center")], feed_dots=0)
        self.assertIn(b"\x1b!\x01\x1ba\x01" + "全灯".encode("utf-8") + b"\n\x1b!\x00\x1ba\x00", job)

    def test_devterm_backend_writes_through_a_pty(self):
        master, slave = os.openpty()
        slave_path = os.ttyname(slave)
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        link = os.path.join(d, "DEVTERM_PRINTER_IN")
        os.symlink(slave_path, link)
        try:
            import tty
            tty.setraw(slave)  # socat creates the pair in raw mode
        except Exception:
            pass
        got = bytearray()
        done = threading.Event()

        def reader():
            os.set_blocking(master, True)
            while not done.is_set():
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                got.extend(chunk)

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        p = printer.DevTermPrinter(path=link, lock_file=os.path.join(d, "lock"), unicode_config=os.path.join(d, "none"))
        self.assertTrue(p.available())
        r = receipt.test_receipt("DevTerm")
        res = p.print_receipt(r)
        expected = printer.encode_job(r.segments(unicode_ok=False), feed_dots=p.feed_dots)
        self.assertTrue(helpers.wait_for(lambda: len(got) >= len(expected), timeout=5))
        done.set()
        os.close(slave)
        os.close(master)
        self.assertEqual(bytes(got[:len(expected)]), expected)
        self.assertIn("dot rows", res.detail)

    def test_missing_printer_and_file_backend(self):
        p = printer.DevTermPrinter(path="/nonexistent/DEVTERM_PRINTER_IN")
        self.assertFalse(p.available())
        with self.assertRaises(printer.PrinterError) as cm:
            p.print_receipt(receipt.test_receipt())
        self.assertEqual(cm.exception.code, "no_port")
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        fp = printer.FilePrinter(d)
        res = fp.print_receipt(receipt.test_receipt())
        self.assertTrue(os.path.isfile(res.path))
        self.assertTrue(os.path.isfile(res.path[:-4] + ".txt"))
        self.assertIsInstance(printer.make_printer("auto", path="/nonexistent"), printer.FilePrinter)
        self.assertIsInstance(printer.make_printer("devterm", path="/nonexistent"), printer.DevTermPrinter)

    def test_unicode_font_probe(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        cfg = os.path.join(d, "devterm-printer")
        ttf = os.path.join(d, "font.ttf")
        open(ttf, "w").close()
        with open(cfg, "w") as f:
            f.write("TTF=%s\n" % ttf)
        self.assertTrue(printer.unicode_font_configured(cfg))
        with open(cfg, "w") as f:
            f.write("TTF=/nope.ttf\n")
        self.assertFalse(printer.unicode_font_configured(cfg))


if __name__ == "__main__":
    unittest.main()
