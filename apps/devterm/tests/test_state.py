import os
import shutil
import tempfile
import threading
import time
import unittest

import fixtures as fx
from helpers import wait_for

from ce_devterm import printer, proto, surface
from ce_devterm.executor import Executor
from ce_devterm.model import AppState
from ce_devterm.tape import Names, evidence_measure, format_row, rows_from_message


class SurfaceTest(unittest.TestCase):
    def test_v1_spec_merges_hacks_and_controls_by_id(self):
        s = surface.from_ui_spec(fx.light_ui_spec())
        self.assertEqual(s.spec_id, "spec_light")
        self.assertEqual(s.card_id, "card_light")
        self.assertEqual(s.device_name, "Ceiling light")
        self.assertEqual(s.channel, "ir")
        self.assertEqual(s.model_id, "muse-spark-1.3")
        ids = [i.id for i in s.items]
        self.assertEqual(ids, ["h_bright", "h_off", "h_night", "h_power", "d_breathe"])
        bright = s.find("h_bright")
        self.assertEqual((bright.kind, bright.label, bright.min, bright.max, bright.step), ("stepped", "Set brightness", 0, 100, 10))
        self.assertEqual(bright.value, 70)
        self.assertTrue(bright.armed)
        self.assertEqual(bright.verdict, "ok")
        off = s.find("h_off")
        self.assertEqual(off.kind, "action")
        self.assertFalse(off.operable)  # the gen3d control says disarmed
        self.assertEqual(s.find("h_night").verdict, "fail")
        power = s.find("h_power")
        self.assertEqual(power.kind, "toggle")
        self.assertTrue(power.numeric_toggle)
        d = s.find("d_breathe")
        self.assertEqual((d.kind, d.rate_hz, d.status), ("daemon", 2.0, "running"))
        self.assertEqual([i.id for i in s.hacks], ["h_bright", "h_off", "h_night", "h_power"])
        self.assertEqual([i.id for i in s.daemons], ["d_breathe"])

    def test_event_values_follow_protocol_v1(self):
        s = surface.from_ui_spec(fx.light_ui_spec())
        self.assertIs(surface.event_value(s.find("h_off")), True)  # action hack: value true
        b = s.find("h_bright")
        b.value = b.nudge(+1)
        self.assertEqual(b.value, 80)
        self.assertEqual(surface.event_value(b), 80)  # control hack: a number in its param range
        p = s.find("h_power")
        p.value = p.nudge(-1)
        self.assertEqual(surface.event_value(p), 0)  # toggle archetype on a hack: a number, not a boolean
        self.assertEqual(p.value_text(), "OFF")

    def test_v0_widgets(self):
        s = surface.from_ui_spec(fx.v0_ui_spec())
        kinds = {i.id: i.kind for i in s.items}
        self.assertEqual(kinds, {"cutoff": "continuous", "chord": "action", "hold": "toggle", "morph": "xy", "kit": "pads"})
        c = s.find("cutoff")
        self.assertEqual(c.value, 64)
        self.assertEqual(c.nudge(+1), 70)  # 1/20 of 0..127 rounded to the step
        self.assertEqual(c.nudge(+1, coarse=True), 89)
        self.assertEqual(surface.event_value(s.find("hold")), False)
        self.assertEqual(surface.event_value(s.find("morph")), {"x": 0.0, "y": 0.0})
        self.assertIsNone(s.armed)

    def test_value_text_and_bars(self):
        it = surface.Item("x", "stepped", "Warmth", min_=0, max_=4, step=1, value=1, step_labels=["COOL", "NEUTRAL", "WARM", "AMBER", "CANDLE"])
        self.assertEqual(it.value_text(), "NEUTRAL")
        it = surface.Item("y", "continuous", "Level", min_=0, max_=100, value=37.5, unit="%")
        self.assertEqual(it.value_text(), "37.5 %")
        self.assertAlmostEqual(it.fraction(), 0.375)
        it.value = it.nudge(+1)
        self.assertEqual(it.value, 42.5)
        it.value = 1000
        self.assertEqual(it.fraction(), 1.0)

    def test_garbage_is_tolerated(self):
        s = surface.from_ui_spec({"specId": "x", "widgets": [{"kind": "knob"}, "nope", {"id": "a", "kind": "??", "range": {"min": "a"}}]})
        self.assertEqual([i.id for i in s.items], ["a"])
        self.assertEqual(surface.from_ui_spec({}).items, [])


class TapeTest(unittest.TestCase):
    def setUp(self):
        self.names = Names()
        self.names.cards = {"card_light": {"name": "light"}}
        self.names.actions = {"ir.darker": "dimmer"}

    def test_verify_result_row(self):
        r = rows_from_message(fx.env("verify.result", fx.evidence()), self.names)[0]
        self.assertEqual((r.verb, r.device, r.command, r.state, r.measure, r.verdict), ("SENT", "light", "dimmer", "SEEN", "-38 % lum", "ok"))
        r = rows_from_message(fx.env("verify.result", fx.evidence(pass_=False, delta=0.02)), self.names)[0]
        self.assertEqual((r.measure, r.verdict), ("no change", "fail"))
        line = format_row(r, 120)
        self.assertTrue(line.split()[1] == "SENT")

    def test_measures(self):
        self.assertEqual(evidence_measure({"metric": "rb-ratio", "delta": 0.08, "threshold": 0.05}, True), "+8 % R/B")
        self.assertEqual(evidence_measure({"metric": "centroid", "delta": 420, "threshold": 100}, True), "+420 Hz")
        self.assertEqual(evidence_measure({"metric": "rms", "delta": 6.2, "threshold": 3}, True), "+6.2 dB")

    def test_steps_learn_refused_and_direct_rows(self):
        st = rows_from_message(fx.env("agent.step", {"stepId": "s1", "cardId": "card_light", "phase": "identify", "status": "ok",
                                                      "title": "Koizumi KRH-TG-9A", "model": "muse-spark-1.3", "latencyMs": 2100}), self.names)[0]
        self.assertEqual((st.verb, st.state, st.measure, st.model, st.verdict), ("IDENTIFY", "ok", "2.1 s", "muse-spark-1.3", None))
        learn = rows_from_message(fx.env("agent.step", {"stepId": "s2", "cardId": "card_light", "phase": "link", "status": "ok",
                                                        "title": "#3 captured", "evidence": "68 marks"}), self.names)[0]
        self.assertEqual((learn.verb, learn.command, learn.measure), ("LEARN", "#3 captured", "68 marks"))
        ref = rows_from_message(fx.env("link.result", {"linkId": "l1", "cardId": "card_light", "verdict": "mismatch",
                                                       "evidence": [{"kind": "midi-identity", "ok": False, "detail": "EP-133 answered"}]}), self.names)[0]
        self.assertEqual((ref.verb, ref.command, ref.state, ref.verdict), ("REFUSED", "EP-133 answered", "wrong device", "fail"))
        direct = rows_from_message(fx.env("x.tape", {"tape": {"verb": "learn", "device": "light", "command": "#4 captured", "measure": "70 marks"}}), self.names)[0]
        self.assertEqual((direct.verb, direct.command), ("LEARN", "#4 captured"))
        self.assertEqual(rows_from_message(fx.env("scan.result", {"frameId": "f"}), self.names), [])

    def test_fixture_replay_marks_the_model(self):
        st = rows_from_message(fx.env("agent.step", {"stepId": "s1", "phase": "forge", "status": "running", "title": "hacks",
                                                     "model": "muse-spark-1.3", "source": "fixture"}), self.names)[0]
        self.assertEqual(st.model, "muse-spark-1.3 (replay)")


class AppStateTest(unittest.TestCase):
    def test_messages_build_the_screens(self):
        s = AppState("DevTerm")
        s.apply(fx.env("welcome", {"deviceId": "dev-1", "name": "DevTerm", "mode": "fixture"}))
        self.assertEqual((s.device_id, s.mode), ("dev-1", "fixture"))
        s.apply(fx.env("device.card", {"cardId": "card_light", "name": "Ceiling light", "maker": "KOIZUMI", "model": "", "category": "lighting",
                                       "confidence": 0.8, "protocols": ["ir"], "evidence": []}))
        s.apply(fx.env("ui.spec", fx.light_ui_spec()))
        self.assertEqual(len(s.surfaces), 1)
        s.apply(fx.env("agent.step", {"stepId": "st1", "phase": "forge", "status": "running", "title": "forge", "model": "muse-spark-1.3",
                                      "startedAt": (time.time() - 25) * 1000}))
        models = s.running_models()
        self.assertEqual(models[0][0], "muse-spark-1.3")
        self.assertGreaterEqual(models[0][1], 24)
        s.apply(fx.env("agent.step", {"stepId": "st1", "phase": "forge", "status": "ok", "title": "forge", "model": "muse-spark-1.3"}))
        self.assertEqual(s.running_models(), [])
        self.assertEqual(len([r for r in s.tape.rows if r.key == "st:st1"]), 1)  # updated in place

    def test_mirror_and_respec_keep_values(self):
        s = AppState("DevTerm")
        s.apply(fx.env("ui.spec", fx.light_ui_spec()))
        s.apply(fx.env("control.event", {"widgetId": "h_bright", "value": 30, "ts": 1, "specId": "spec_light"}, from_="quest"))
        self.assertEqual(s.surfaces[0].find("h_bright").value, 30)
        s.apply(fx.env("ui.spec", fx.light_ui_spec(armed_bright=False)))  # rev with new evidence
        self.assertEqual(len(s.surfaces), 1)
        b = s.surfaces[0].find("h_bright")
        self.assertEqual(b.value, 30)
        self.assertFalse(b.operable)

    def test_effects_expire(self):
        s = AppState("DevTerm")
        s.on_effect({"invert": True, "ms": 50})
        self.assertIn("invert", s.active_effects())
        time.sleep(0.08)
        self.assertNotIn("invert", s.active_effects())


class FakeSound(object):
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def beep(self, freq, ms, count, interval_ms=1000):
        self.calls.append(("beep", freq, ms, count))
        return self.ok, "fake beep"

    def say(self, text):
        self.calls.append(("say", text))
        return self.ok, "fake say"

    def stop(self):
        self.calls.append(("stop",))


class ExecutorTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.sent = []
        self.ui = []
        self.sound = FakeSound()
        self.ex = Executor(printer.FilePrinter(self.dir), self.sound, send=self._send, ui=lambda k, d: self.ui.append((k, d)),
                           device_id=lambda: "dev-1", device_name="DevTerm", platform="darwin")

    def _send(self, type_, payload, to=None, keep=False):
        self.sent.append((type_, payload, to, keep))
        return True

    def ack(self):
        self.assertTrue(wait_for(lambda: self.sent, timeout=5))
        return self.sent[-1]

    def test_print_writes_a_preview_and_acks(self):
        op = {"kind": "local", "op": "print", "arg": {"title": "BLACKOUT", "lines": ["light off (seen)"], "models": ["muse-spark-1.3"]}}
        self.assertTrue(self.ex.submit(fx.exec_command(op)))
        t, p, to, keep = self.ack()
        self.assertEqual((t, to, keep), ("exec.ack", "server", True))
        self.assertTrue(p["ok"])
        self.assertEqual(p["execId"], "ex42")
        self.assertIn("preview", p["detail"])
        self.assertIsInstance(p["sentAt"], int)
        self.assertTrue(any(k == "preview" for k, _ in self.ui))
        self.assertTrue(any(f.endswith(".png") for f in os.listdir(self.dir)))

    def test_not_for_me_is_ignored(self):
        self.assertFalse(self.ex.submit(fx.exec_command({"kind": "local", "op": "beep"}, executor="someone-else")))
        self.assertFalse(self.ex.submit(fx.env("control.event", {"widgetId": "x", "value": 1, "ts": 1})))

    def test_beep_say_screen(self):
        self.ex.submit(fx.exec_command({"kind": "local", "op": "beep", "arg": {"freq": 2000, "count": 3, "ms": 120}}, exec_id="b1"))
        self.assertTrue(self.ack()[1]["ok"])
        self.assertEqual(self.sound.calls[0], ("beep", 2000.0, 120, 3))
        self.ex.submit(fx.exec_command({"kind": "local", "op": "say", "arg": "blackout armed"}, exec_id="s1"))
        self.assertTrue(wait_for(lambda: len(self.sent) >= 2))
        self.assertTrue(self.sent[1][1]["ok"])
        self.ex.submit(fx.exec_command({"kind": "local", "op": "screen", "arg": "invert"}, exec_id="sc1"))
        self.assertTrue(wait_for(lambda: len(self.sent) >= 3))
        self.assertTrue(self.sent[2][1]["ok"])
        self.assertTrue(any(k == "screen" and d.get("invert") for k, d in self.ui))

    def test_errors_use_protocol_codes(self):
        self.ex.submit(fx.exec_command({"kind": "midi", "msg": "cc", "channel": 1, "number": 1, "value": 3}, exec_id="m1"))
        self.assertTrue(wait_for(lambda: len(self.sent) >= 1))
        self.assertEqual(self.sent[0][1]["error"], "unsupported")
        self.ex.submit(fx.exec_command({"kind": "local", "op": "torch", "arg": 1}, exec_id="t1"))
        self.assertTrue(wait_for(lambda: len(self.sent) >= 2))
        self.assertEqual(self.sent[1][1]["error"], "unsupported")
        self.ex.submit(fx.exec_command({"kind": "local", "op": "beep", "arg": {"freq": 50000}}, exec_id="b2"))
        self.assertTrue(wait_for(lambda: len(self.sent) >= 3))
        self.assertEqual(self.sent[2][1]["error"], "bad_args")
        self.ex.submit(fx.exec_command({"kind": "local", "op": "volume", "arg": 50}, exec_id="v1"))
        self.assertTrue(wait_for(lambda: len(self.sent) >= 4))
        self.assertEqual(self.sent[3][1]["error"], "unsupported")  # volume is Linux-only
        for t, p, to, keep in self.sent:
            self.assertIn(p["error"], proto.EXEC_ERRORS)
            self.assertFalse(p["ok"])

    def test_dry_run_does_not_actuate(self):
        self.ex.submit(fx.exec_command({"kind": "local", "op": "print", "arg": "x"}, dry=True))
        t, p, to, keep = self.ack()
        self.assertTrue(p["ok"])
        self.assertIn("dry run", p["detail"])
        self.assertEqual(os.listdir(self.dir), [])

    def test_experimental_type_gets_an_experimental_ack(self):
        self.ex.submit(fx.exec_command({"kind": "local", "op": "beep", "arg": 1000}, type_="x.exec.command"))
        self.assertEqual(self.ack()[0], "x.exec.ack")

    def test_panic_drops_queued_jobs(self):
        gate = threading.Event()
        orig = self.ex._op_print

        def slow(arg, dry):
            gate.wait(2)
            return orig(arg, dry)

        self.ex._op_print = slow
        for i in range(3):
            self.ex.submit(fx.exec_command({"kind": "local", "op": "print", "arg": "x"}, exec_id="p%d" % i))
        time.sleep(0.1)
        dropped = self.ex.panic()
        gate.set()
        self.assertEqual(dropped, 2)
        self.assertTrue(wait_for(lambda: len(self.sent) >= 3, timeout=5))
        refused = [p for t, p, to, k in self.sent if p.get("error") == "refused"]
        self.assertEqual(len(refused), 2)
        self.assertIn(("stop",), self.sound.calls)


if __name__ == "__main__":
    unittest.main()
