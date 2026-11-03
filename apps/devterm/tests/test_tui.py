"""The curses screens, drawn into a fake window (no terminal), and the keys that drive them."""
import curses
import shutil
import tempfile
import time
import unittest

import screens

from ce_devterm import receipt
from ce_devterm.pairing import PairingSession


class FakeApi(object):
    pass


def pairing_session():
    s = PairingSession(FakeApi(), "DevTerm")
    s.status = "pending"
    s.pairing_id = "pid1"
    s.display = "K7Q-4M2"
    s.code = "K7Q4M2"
    s.qr = "https://192.168.1.4:8443/p/pid1#K7Q4M2"
    s.expires_at = (time.time() + 271) * 1000
    s.started_at = time.time()
    return s


class TuiTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.app = screens.make_app(self.dir)
        self.addCleanup(self.app.stop)

    def tui(self, h=30, w=128):
        return screens.make_tui(self.app, h, w)

    def test_status_line_shows_link_and_running_model(self):
        text = screens.render(self.tui(), "hacks")
        first = text.splitlines()[0]
        self.assertIn("CONTROL ANYTHING", first)
        self.assertIn("LINKED", first)
        self.assertIn("muse-spark-1.3 · 25 s", first)

    def test_hacks_beside_the_tape_on_a_wide_screen(self):
        text = screens.render(self.tui(30, 128), "hacks")
        self.assertIn("1 (o) Set brightness", text)
        self.assertIn("70 %", text)
        self.assertIn("disarmed", text)  # the gen3d spec says the off hack is not verified yet
        self.assertIn("EVIDENCE TAPE", text)
        self.assertIn("-38 % lum", text)
        self.assertIn("no change", text)
        self.assertIn("✓", text)
        self.assertIn("✗", text)

    def test_every_view_fits_80x24(self):
        t = self.tui(24, 80)
        for view in ("hacks", "tape", "daemons", "room"):
            text = screens.render(t, view)
            lines = text.splitlines()
            self.assertLessEqual(len(lines), 24)
            self.assertTrue(all(len(l) <= 80 for l in lines), view)
        self.assertIn("Breathe to tempo", screens.render(t, "daemons"))
        room = screens.render(t, "room")
        self.assertIn("Cardputer", room)
        self.assertIn("verified via Cardputer", room)

    def test_tiny_terminal(self):
        text = screens.render(self.tui(8, 30), "hacks")
        self.assertIn("40x10", text)

    def test_arrow_keys_send_control_events(self):
        t = self.tui()
        t.view = "hacks"
        t._key(curses.KEY_RIGHT)
        sent = self.app.link.sent
        self.assertEqual(sent[-1][0], "control.event")
        self.assertEqual(sent[-1][1]["widgetId"], "h_bright")
        self.assertEqual(sent[-1][1]["value"], 80)
        self.assertEqual(sent[-1][1]["phase"], "start")
        self.app._adjust[("spec_light", "h_bright")]["last_key"] -= 1  # pretend the key was released
        self.app.tick()
        self.assertEqual(sent[-1][1]["phase"], "end")
        self.assertTrue(any(r.verb == "SENT" and r.measure == "80 %" for r in self.app.state.tape.rows))

    def test_digit_uploads_and_disarmed_hacks_are_refused(self):
        t = self.tui()
        t.view = "hacks"
        n = len(self.app.link.sent)
        t._key("2")  # Turn light off: disarmed in the gen3d spec
        self.assertEqual(len(self.app.link.sent), n)
        self.assertIn("disarmed", self.app.state.toast)
        t._key("4")  # Toggle power is a control: Enter/digit re-sends its value
        self.assertEqual(self.app.link.sent[-1][1]["widgetId"], "h_power")

    def test_irreversible_local_hack_asks_y(self):
        t = self.tui()
        t.view = "hacks"
        t._key("]")  # the built-in self-test surface
        self.assertTrue(t._surface().local)
        t._key("1")  # Print receipt: paper, asks first
        self.assertIsNotNone(t.prompt)
        self.assertIn("cannot be undone", t.prompt["label"])
        t._key("n")
        self.assertIsNone(t.prompt)
        t._key("1")
        t._key("y")
        self.assertTrue(screens.wait_for_file(self.dir, ".png"))

    def test_typed_command_prompt(self):
        t = self.tui()
        t.view = "hacks"
        t._key(":")
        for ch in "make it warmer":
            t._key(ch)
        text = screens.render(t)
        self.assertIn("COMMAND: make it warmer_", text)
        t._key("\n")
        msg = self.app.link.sent[-1]
        self.assertEqual(msg[0], "voice.text")
        self.assertEqual(msg[1]["text"], "make it warmer")
        self.assertEqual(msg[1]["cardId"], "card_light")
        self.assertEqual(msg[2], "server")

    def test_panic_asks_then_sends(self):
        t = self.tui()
        t._key("!")
        t._key("y")
        self.assertEqual(self.app.link.sent[-1][0], "panic")

    def test_tab_cycles_views(self):
        t = self.tui()
        seen = []
        for _ in range(4):
            seen.append(t.view)
            t._key("\t")
        self.assertEqual(seen, ["hacks", "tape", "daemons", "room"])

    def test_pair_screen_has_qr_code_and_countdown(self):
        self.app.phase = "pair"
        self.app.pair_session = pairing_session()
        self.app.pair_info = {"state": "pending"}
        text = screens.render(self.tui(30, 128))
        self.assertIn("LINK REQUEST", text)
        self.assertIn("type this code on the Mac", text)
        self.assertIn("or look at it from the headset", text)
        self.assertIn("waiting for approval", text)
        self.assertIn("valid 4:3", text)
        self.assertIn("████", text)  # the big passcode
        # narrow: the code goes under the QR, still big
        text = screens.render(self.tui(40, 60))
        self.assertIn("type this code on the Mac", text)

    def test_pairing_qr_payloads(self):
        s = pairing_session()
        self.assertEqual(s.qr_payload("short"), "CE1:K7Q4M2")  # a version-1 QR: readable from far away
        self.assertEqual(s.qr_payload("url"), "https://192.168.1.4:8443/p/pid1#K7Q4M2")
        from ce_devterm import qr
        self.assertEqual(len(qr.matrix(s.qr_payload("short"))), 21)

    def test_first_run_asks_for_the_mac_and_starts_pairing(self):
        from helpers import FakeApi, wait_for
        from ce_devterm import app as app_mod
        api = FakeApi(approve_after=100)
        self.addCleanup(api.stop)
        opts = app_mod.Options(server=None, printer="file", print_dir=self.dir, identity_path=self.dir + "/fresh.json")
        a = app_mod.App(opts)
        self.addCleanup(a.stop)
        t = screens.make_tui(a, 30, 100)
        a.start()
        self.assertEqual(a.phase, "setup")
        t._ask_server()
        self.assertIn("MAC ADDRESS", screens.render(t))
        for ch in "127.0.0.1:%d" % api.port:
            t._key(ch)
        t._key("\n")
        self.assertEqual(a.phase, "pair")
        self.assertTrue(wait_for(lambda: (a.pump() or True) and a.pair_session is not None and a.pair_session.display == "K7Q-4M2"))
        self.assertIn("type this code on the Mac", screens.render(t))
        self.assertEqual(api.starts[0]["kind"], "devterm")

    def test_preview_overlay_and_effects(self):
        t = self.tui()
        r = receipt.from_print_arg({"title": "BLACKOUT", "lines": ["light off (seen)"]})
        self.app.state.preview = {"lines": r.preview(), "path": "/tmp/x/20261102-blackout.png"}
        t.overlay = "preview"
        text = screens.render(t)
        self.assertIn("RECEIPT PREVIEW", text)
        self.assertIn("BLACKOUT", text)
        self.assertIn("20261102-blackout.png", text)
        t._key("x")  # any key closes it
        self.assertIsNone(t.overlay)
        self.app.state.on_effect({"banner": "HELLO", "ms": 2000})
        self.assertIn("█", screens.render(t))


if __name__ == "__main__":
    unittest.main()
