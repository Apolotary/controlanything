#!/usr/bin/env python3
"""Dev tool: make a paired DevTerm run a LocalOp through the real hub, without the agent loop.

Clients may not send exec.command (server-only), so this sends the experimental twin `x.exec.command`,
which the DevTerm executes the same way (and answers with `x.exec.ack` to the server). The sender pairs
as a temporary "web" device via localhost (auto-approved), and revokes itself afterwards.

    python3 apps/devterm/scripts/send_exec.py --to devterm print '{"title":"RECEIPT","lines":["hello"]}'
    python3 apps/devterm/scripts/send_exec.py --to devterm beep '{"freq":2000,"count":3,"ms":120}'
    python3 apps/devterm/scripts/send_exec.py --to devterm screen invert
    python3 apps/devterm/scripts/send_exec.py --to devterm say "link verified"

--to takes a deviceId or a case-insensitive name/kind substring of an online device.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from ce_devterm import config, proto  # noqa: E402
from ce_devterm.pairing import Api, PairingSession  # noqa: E402
from ce_devterm.ws import WebSocket  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="127.0.0.1:8787")
    ap.add_argument("--to", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("op", help="print | beep | say | screen | volume (anything else tests the 'unsupported' ack)")
    ap.add_argument("arg", nargs="?")
    a = ap.parse_args()
    server = config.parse_server(a.server)
    if not server.is_loopback():
        print("run this on the Mac itself (localhost pairing is auto-approved)", file=sys.stderr)
        return 2
    arg = None
    if a.arg is not None:
        try:
            arg = json.loads(a.arg)
        except ValueError:
            arg = a.arg
    api = Api(server.http)
    sess = PairingSession(api, "exec test (temporary)", "web", ["display"]).start()
    if sess.status != "approved":
        print("pairing was not auto-approved: %s" % sess.status, file=sys.stderr)
        return 1
    try:
        w = WebSocket.connect(server.ws, timeout=4)
        w.send_text(proto.encode(proto.envelope("hello", proto.hello(sess.token, ["display"], app="send_exec"))))
        target = None
        deadline = time.time() + 4
        while time.time() < deadline and target is None:
            got = w.recv(timeout=1)
            if not got:
                continue
            m = proto.parse(got[1])
            if m["type"] == "presence":
                for d in m["payload"].get("devices") or []:
                    hay = ("%s %s %s" % (d.get("deviceId"), d.get("name"), d.get("kind"))).lower()
                    if d.get("online") and (d.get("deviceId") == a.to or a.to.lower() in hay) and d.get("deviceId") != sess.device_id:
                        target = d
                        break
        if target is None:
            print("no online device matches %r" % a.to, file=sys.stderr)
            return 1
        op = {"kind": "local", "op": a.op}
        if arg is not None:
            op["arg"] = arg
        payload = {"execId": proto.new_id("ex"), "executorDeviceId": target["deviceId"], "op": op}
        if a.dry_run:
            payload["dryRun"] = True
        w.send_text(proto.encode(proto.envelope("x.exec.command", payload, to=target["deviceId"])))
        print("sent x.exec.command %s to %s (%s)" % (json.dumps(op), target["name"], target["deviceId"]))
        time.sleep(0.5)
        w.close()
    finally:
        try:
            api._request("DELETE", "/api/devices/%s" % sess.device_id)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
