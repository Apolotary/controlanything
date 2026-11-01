import json
import os
import shutil
import stat
import tempfile
import unittest

from helpers import FakeApi, FakeHub, env, wait_for

from ce_devterm import config, proto
from ce_devterm.link import Link
from ce_devterm.pairing import Api, ApiError, PairingSession, Unreachable


class Recorder(object):
    def __init__(self):
        self.events = []

    def __call__(self, kind, data):
        self.events.append((kind, data))

    def states(self):
        return [d["state"] for k, d in self.events if k == "status"]

    def messages(self, type_=None):
        return [d for k, d in self.events if k == "message" and (type_ is None or d.get("type") == type_)]


class LinkTest(unittest.TestCase):
    def make(self, hub, token="good", **kw):
        rec = Recorder()
        link = Link(hub.server.url, token, rec, app="ce-devterm@test", backoff=(0.05, 0.2), **kw)
        self.addCleanup(link.stop)
        return link, rec

    def test_hello_welcome_and_send(self):
        hub = FakeHub()
        self.addCleanup(hub.stop)
        link, rec = self.make(hub)
        link.start()
        self.assertTrue(wait_for(lambda: link.online))
        hello = hub.received[0]
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(hello["v"], 1)
        self.assertEqual(hello["payload"]["deviceToken"], "good")
        self.assertEqual(hello["payload"]["capabilities"], proto.CAPABILITIES)
        self.assertEqual(hello["payload"]["app"], "ce-devterm@test")
        self.assertEqual(link.device_id, "dev-1")
        self.assertTrue(link.send("control.event", proto.control_event("h_dim", 40, spec_id="s1", phase="end")))
        self.assertTrue(wait_for(lambda: any(m["type"] == "control.event" for m in hub.received)))
        ev = [m for m in hub.received if m["type"] == "control.event"][0]
        self.assertEqual(ev["payload"]["widgetId"], "h_dim")
        hub.push(env("agent.step", {"stepId": "st1", "phase": "identify", "status": "running", "title": "identify"}))
        self.assertTrue(wait_for(lambda: rec.messages("agent.step")))

    def test_capability_fallback_for_an_older_hub(self):
        hub = FakeHub(reject_caps="printer")
        self.addCleanup(hub.stop)
        link, rec = self.make(hub)
        link.start()
        self.assertTrue(wait_for(lambda: link.online))
        hellos = [m for m in hub.received if m["type"] == "hello"]
        self.assertEqual(len(hellos), 2)
        self.assertEqual(hellos[1]["payload"]["capabilities"], proto.BASE_CAPS)

    def test_reconnects_after_the_hub_drops_and_flushes_kept_acks(self):
        hub = FakeHub()
        self.addCleanup(hub.stop)
        link, rec = self.make(hub)
        link.start()
        self.assertTrue(wait_for(lambda: link.online))
        for c in list(hub.live):
            c.shutdown()
        hub.live[:] = []
        self.assertTrue(wait_for(lambda: not link.online))
        # offline: control events are dropped, acks are kept
        self.assertFalse(link.send("control.event", proto.control_event("x", 1)))
        link.send("exec.ack", proto.exec_ack("e1", True, 1), to="server", keep=True)
        self.assertTrue(wait_for(lambda: hub.connections >= 2 and link.online, timeout=5))
        self.assertTrue(wait_for(lambda: any(m["type"] == "exec.ack" for m in hub.received)))
        self.assertFalse(any(m["type"] == "control.event" for m in hub.received))
        self.assertIn("offline", rec.states())

    def test_rejected_token_stops_reconnecting(self):
        hub = FakeHub()
        self.addCleanup(hub.stop)
        link, rec = self.make(hub, token="revoked")
        link.start()
        self.assertTrue(wait_for(lambda: link.state == "unauthorized"))
        n = hub.connections
        import time
        time.sleep(0.5)
        self.assertEqual(hub.connections, n)

    def test_server_down_reports_offline_with_retry(self):
        link, rec = Link("ws://127.0.0.1:9/ws", "good", Recorder(), backoff=(0.05, 0.1)), None
        rec = link.on_event
        self.addCleanup(link.stop)
        link.start()
        self.assertTrue(wait_for(lambda: "offline" in rec.states()))
        st = [d for k, d in rec.events if k == "status" and d["state"] == "offline"][0]
        self.assertIn("retryIn", st)


class PairingTest(unittest.TestCase):
    def test_device_code_flow_with_polling(self):
        api_srv = FakeApi(approve_after=2)
        self.addCleanup(api_srv.stop)
        s = PairingSession(Api(api_srv.base), "DevTerm")
        s.start()
        self.assertEqual(s.status, "pending")
        self.assertEqual(s.display, "K7Q-4M2")
        self.assertTrue(s.qr.startswith("https://"))
        self.assertGreater(s.seconds_left(), 250)
        self.assertEqual(api_srv.starts[0]["kind"], "devterm")
        self.assertEqual(api_srv.starts[0]["capabilities"], proto.CAPABILITIES)
        self.assertEqual(s.poll(), "pending")
        self.assertEqual(s.poll(), "approved")
        self.assertEqual((s.device_id, s.token), ("dev-9", "tok-9"))
        self.assertTrue(s.done)

    def test_localhost_auto_approval_returns_the_token_at_once(self):
        api_srv = FakeApi(auto_approve=True)
        self.addCleanup(api_srv.stop)
        s = PairingSession(Api(api_srv.base), "DevTerm").start()
        self.assertEqual(s.status, "approved")
        self.assertEqual(s.token, "tok-9")

    def test_capability_fallback_on_400(self):
        api_srv = FakeApi(strict_caps=proto.BASE_CAPS)
        self.addCleanup(api_srv.stop)
        s = PairingSession(Api(api_srv.base), "DevTerm").start()
        self.assertEqual(s.status, "pending")
        self.assertEqual(api_srv.starts[-1]["capabilities"], proto.BASE_CAPS)

    def test_denied_and_unreachable(self):
        api_srv = FakeApi(deny=True)
        self.addCleanup(api_srv.stop)
        s = PairingSession(Api(api_srv.base), "DevTerm").start()
        self.assertEqual(s.poll(), "denied")
        with self.assertRaises(Unreachable):
            Api("http://127.0.0.1:9", timeout=1).health()

    def test_me_and_health(self):
        api_srv = FakeApi()
        self.addCleanup(api_srv.stop)
        api = Api(api_srv.base)
        self.assertIsNone(api.me("nope"))
        self.assertEqual(api.me("tok-9")["device"]["deviceId"], "dev-9")
        self.assertEqual(api.health()["urls"]["lan"], ["10.0.0.5"])
        with self.assertRaises(ApiError) as cm:
            api._request("GET", "/api/nothing")
        self.assertEqual(cm.exception.status, 404)


class ConfigTest(unittest.TestCase):
    def test_parse_server_forms(self):
        self.assertEqual(config.parse_server("192.168.1.14").http, "http://192.168.1.14:8787")
        self.assertEqual(config.parse_server("192.168.1.14:9000").ws, "ws://192.168.1.14:9000/ws")
        self.assertEqual(config.parse_server("http://mac.local:8787/").display, "mac.local:8787")
        self.assertEqual(config.parse_server("ws://10.0.0.2:8787/ws").http, "http://10.0.0.2:8787")
        self.assertTrue(config.parse_server("localhost").is_loopback())
        with self.assertRaises(ValueError):
            config.parse_server("https://mac:8443")
        with self.assertRaises(ValueError):
            config.parse_server("")

    def test_identity_saved_0600_atomically_and_forgotten(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "sub", "device.json")
        ident = config.Identity(server="http://10.0.0.2:8787", device_id="dev-9", token="tok-9", path=path)
        ident.save()
        mode = stat.S_IMODE(os.stat(path).st_mode)
        self.assertEqual(mode, 0o600)
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(data["deviceToken"], "tok-9")
        back = config.Identity.load(path)
        self.assertTrue(back.paired)
        back.forget()
        again = config.Identity.load(path)
        self.assertFalse(again.paired)
        self.assertEqual(again.server, "http://10.0.0.2:8787")
        self.assertEqual([f for f in os.listdir(os.path.dirname(path)) if f.endswith(".tmp")], [])

    def test_corrupt_identity_loads_unpaired(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "device.json")
        with open(path, "w") as f:
            f.write("{not json")
        self.assertFalse(config.Identity.load(path).paired)


if __name__ == "__main__":
    unittest.main()
