"""Command line entry point.

  ce-devterm [--server MAC[:PORT]]          the terminal UI (pairs first if needed)
  ce-devterm --demo                         against `npm run dev` on this machine (separate demo identity)
  ce-devterm --headless                     no curses: executor + evidence tape on stdout (a service)
  ce-devterm pair | unpair | doctor | print-test [--ticket] | qr TEXT | install | --version
"""
import argparse
import json
import os
import platform
import shutil
import sys
import time

from . import __version__, bigtext, config, printer as printer_mod, proto, qr as qrmod, receipt, sound
from . import tape as tapemod
from .theme import ansi, unicode_ok


def _color_ok(stream=sys.stdout):
    return stream.isatty() and os.environ.get("TERM", "dumb") != "dumb" and "NO_COLOR" not in os.environ


DEFAULTS = {
    "server": None, "demo": False, "pair_via_lan": False, "name": None, "headless": False, "printer": "auto",
    "print_dir": None, "open_receipts": False, "ticket": "auto", "density": None, "identity": None, "ascii": False,
    "mono": False, "no_self_test": False,
}


def _common():
    """Options accepted before or after the subcommand (defaults applied after parsing)."""
    S = argparse.SUPPRESS
    c = argparse.ArgumentParser(add_help=False)
    c.add_argument("--server", "-s", default=S, help="the Mac running the server: HOST[:PORT] or http://HOST:PORT (default port 8787)")
    c.add_argument("--demo", action="store_true", default=S, help="run against `npm run dev` on this machine (server 127.0.0.1:8787, demo identity)")
    c.add_argument("--pair-via-lan", action="store_true", default=S, help="with --demo: pair through the Mac's LAN address so the QR/passcode approval is shown")
    c.add_argument("--name", default=S, help="device name shown to the other clients (default: DevTerm)")
    c.add_argument("--headless", action="store_true", default=S, help="no terminal UI: run the executor and print the evidence tape")
    c.add_argument("--printer", choices=["auto", "devterm", "file", "none"], default=S,
                   help="auto (default) = the DevTerm printer if /tmp/DEVTERM_PRINTER_IN exists, else PNG previews")
    c.add_argument("--print-dir", default=S, help="where previews go when there is no printer (default ~/.cache/controleverything/receipts)")
    c.add_argument("--open-receipts", action="store_true", default=S, help="open each preview PNG in the desktop viewer")
    c.add_argument("--ticket", choices=["auto", "always", "never"], default=S, help="print the LINK REQUEST ticket when pairing (auto: on paper only)")
    c.add_argument("--density", type=int, default=S, help="printer density 0-15 (default: the daemon's)")
    c.add_argument("--identity", default=S, help="token file (default ~/.config/controleverything/device.json)")
    c.add_argument("--ascii", action="store_true", default=S, help="ASCII only (no box drawing or block characters)")
    c.add_argument("--mono", action="store_true", default=S, help="no colours")
    c.add_argument("--no-self-test", action="store_true", default=S, help="hide the DevTerm's built-in self-test hacks")
    return c


def build_parser():
    common = _common()
    p = argparse.ArgumentParser(prog="ce-devterm", description="ControlEverything client for the ClockworkPi DevTerm.", parents=[common])
    p.add_argument("--version", action="version", version="ce-devterm %s (Python %s)" % (__version__, platform.python_version()))
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("run", help="the terminal UI (default)", parents=[common])
    sp = sub.add_parser("pair", help="pair on the command line (QR + passcode on stdout)", parents=[common])
    sp.add_argument("--force", action="store_true", help="pair again even if a token exists")
    sub.add_parser("unpair", help="forget this device's token", parents=[common])
    sub.add_parser("doctor", help="check Python, terminal, printer, audio and the server", parents=[common])
    pt = sub.add_parser("print-test", help="print a test receipt (or a preview file without a printer)", parents=[common])
    pt.add_argument("--sample-ticket", action="store_true", help="print a sample LINK REQUEST ticket instead")
    pt.add_argument("--json", help="print a receipt from a LocalOp print argument (JSON object or string)")
    qp = sub.add_parser("qr", help="show TEXT as a QR code in the terminal", parents=[common])
    qp.add_argument("text")
    ip = sub.add_parser("install", help="copy this zipapp to ~/.local/bin/ce-devterm", parents=[common])
    ip.add_argument("--dir", default=os.path.join(os.path.expanduser("~"), ".local", "bin"))
    return p


def parse_args(argv=None):
    args = build_parser().parse_args(argv)
    for k, v in DEFAULTS.items():
        if not hasattr(args, k):
            setattr(args, k, v)
    return args


def _options(args):
    from .app import Options
    server = None
    if args.server:
        server = config.parse_server(args.server)
    elif args.demo:
        server = config.parse_server("127.0.0.1:8787")
        if args.pair_via_lan:
            server = _lan_server(server) or server
    elif os.environ.get("CE_SERVER"):
        server = config.parse_server(os.environ["CE_SERVER"])
    return Options(server=server, name=args.name, demo=args.demo, printer=args.printer, print_dir=args.print_dir,
                   open_receipts=args.open_receipts, ticket=args.ticket,
                   identity_path=args.identity or config.identity_path(args.demo), density=args.density,
                   self_test=not args.no_self_test)


def _lan_server(local):
    """The Mac's LAN address from /api/health, so a demo pairing is not auto-approved as localhost."""
    from .pairing import Api, ApiError
    try:
        h = Api(local.http, timeout=3).health()
    except ApiError:
        return None
    lan = (h.get("urls") or {}).get("lan") or []
    if lan:
        return config.ServerAddress(lan[0], local.port)
    return None


def main(argv=None):
    args = parse_args(argv)
    try:
        cmd = args.cmd or "run"
        if cmd == "qr":
            return cmd_qr(args)
        if cmd == "doctor":
            return cmd_doctor(args)
        if cmd == "print-test":
            return cmd_print_test(args)
        if cmd == "install":
            return cmd_install(args)
        if cmd == "unpair":
            return cmd_unpair(args)
        if cmd == "pair":
            return cmd_pair(args)
        return cmd_run(args)
    except KeyboardInterrupt:
        return 130
    except ValueError as e:
        print("ce-devterm: %s" % e, file=sys.stderr)
        return 2


# ---- run ------------------------------------------------------------------------------------------

def cmd_run(args):
    from .app import App
    opts = _options(args)
    app = App(opts)
    if args.headless or not sys.stdout.isatty():
        return run_headless(app, args)
    from .tui import Tui
    Tui(app, ascii_only=args.ascii, mono=args.mono).run()
    return 0


def run_headless(app, args):
    color = _color_ok() and not args.mono
    if app.server is None:
        print("ce-devterm: no server. Pass --server MAC_IP (or --demo for this machine).", file=sys.stderr)
        return 2
    print(ansi("bone", "CONTROL EVERYTHING", color) + " · %s · headless · %s" % (app.state.name, app.server.display))
    print("printer: %s" % app.printer.describe())
    if not app.identity.paired:
        rc = _pair_cli(app, args)
        if rc:
            return rc
    app.phase = "run"
    app.start_link()
    printed = 0
    last_state = None
    try:
        while not app.quit:
            app.pump()
            st = app.state
            if st.link_state != last_state:
                last_state = st.link_state
                print(ansi("cyan" if st.link_state == "online" else "magenta", "[link] %s %s" % (st.link_state, st.link_detail), color))
                if st.link_state == "unauthorized":
                    print("token rejected: run `ce-devterm pair --force`", file=sys.stderr)
                    return 3
            if st.tape.version != printed:
                printed = st.tape.version
                for r in list(st.tape.rows)[-20:]:
                    _print_row(r, color)
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
    return 0


_SHOWN = {}


def _print_row(r, color):
    """Print a tape row once, and again only if it changed (agent steps update in place)."""
    ident = r.key or id(r)
    key = (r.verb, r.state, r.measure, r.verdict, r.model)
    if _SHOWN.get(ident) == key:
        return
    _SHOWN[ident] = key
    line = tapemod.format_row(r, 120).rstrip()
    v = tapemod.verdict_text(r.verdict, not unicode_ok())
    if v:
        line += "  " + ansi("ok" if r.verdict == "ok" else "fail", v, color)
    if r.model:
        line += "  " + ansi("cyan", r.model, color)
    print(line)
    sys.stdout.flush()


# ---- pairing on the command line --------------------------------------------------------------------

def cmd_pair(args):
    from .app import App
    opts = _options(args)
    app = App(opts)
    if app.server is None:
        print("ce-devterm: pass --server MAC_IP (or --demo)", file=sys.stderr)
        return 2
    if app.identity.paired and not args.force:
        print("already paired as %s (%s); use `pair --force` to pair again" % (app.identity.name, app.identity.device_id))
        return 0
    try:
        return _pair_cli(app, args)
    finally:
        app.stop()


def _pair_cli(app, args):
    from .pairing import Api, ApiError, PairingSession
    color = _color_ok() and not args.mono
    api = Api(app.server.http)
    while True:
        sess = PairingSession(api, app.state.name, "devterm", proto.CAPABILITIES)
        try:
            sess.start()
        except ApiError as e:
            print("cannot start pairing with %s: %s (retrying in 3 s)" % (app.server.display, e), file=sys.stderr)
            time.sleep(3)
            continue
        if sess.status != "approved":
            m = qrmod.matrix(sess.qr or sess.display)
            lines = qrmod.lines_ansi(m) if color else (qrmod.lines_unicode(m) if unicode_ok() else qrmod.lines_ascii(m))
            print()
            for line in lines:
                print("  " + line)
            print()
            big = bigtext.fit(sess.display, shutil.get_terminal_size((80, 24)).columns - 4, ascii_only=not unicode_ok())
            for line in big or [sess.display]:
                print("  " + ansi("volt", line, color))
            print()
            print("  type this code on the Mac or look at it from the headset (%s)" % sess.qr)
            if app._want_ticket():
                r = receipt.pairing_ticket(sess.display, sess.qr, app.state.name, app.server.display, sess.expires_at)
                try:
                    res = app.printer.print_receipt(r)
                    print("  ticket: %s" % res.detail)
                except printer_mod.PrinterError as e:
                    print("  ticket not printed: %s" % e)
            sys.stdout.flush()
        while not sess.done:
            time.sleep(1.5)
            try:
                sess.poll()
            except ApiError as e:
                print("  (status check failed: %s)" % e, file=sys.stderr)
            if sess.status == "pending" and sess.seconds_left() <= 0:
                sess.status = "expired"
        if sess.status == "approved":
            app._on_paired(sess)
            app.stop_link()
            print(ansi("cyan", "  LINK GRANTED", color) + " · %s · token saved to %s" % (app.state.name, app.opts.identity_path))
            return 0
        if sess.status == "denied":
            print("  denied on the approver.", file=sys.stderr)
            return 1
        print("  code expired; requesting a new one…")


def cmd_unpair(args):
    path = args.identity or config.identity_path(args.demo)
    ident = config.Identity.load(path)
    if not ident.paired:
        print("not paired (%s)" % path)
        return 0
    ident.forget()
    print("token forgotten (%s). Revoke it on the Mac too: DELETE /api/devices/%s" % (path, "<deviceId>"))
    return 0


# ---- tools ----------------------------------------------------------------------------------------

def cmd_qr(args):
    m = qrmod.matrix(args.text)
    color = _color_ok() and not args.mono
    lines = qrmod.lines_ansi(m) if color else (qrmod.lines_unicode(m) if unicode_ok() and not args.ascii else qrmod.lines_ascii(m))
    for line in lines:
        print(line)
    return 0


def cmd_print_test(args):
    pr = printer_mod.make_printer(args.printer, out_dir=args.print_dir, density=args.density, open_viewer=args.open_receipts)
    name = args.name or config.default_device_name(args.demo)
    if args.json:
        try:
            arg = json.loads(args.json)
        except ValueError:
            arg = args.json
        r = receipt.from_print_arg(arg, device_name=name)
    elif args.sample_ticket:
        r = receipt.pairing_ticket("K7Q-4M2", "https://192.168.1.14:8443/p/sample#K7Q4M2", name, "192.168.1.14:8787",
                                   (time.time() + 300) * 1000)
    else:
        r = receipt.test_receipt(name)
    print(r.text(), end="")
    try:
        res = pr.print_receipt(r)
    except printer_mod.PrinterError as e:
        print("not printed: %s" % e, file=sys.stderr)
        return 1
    print(res.detail)
    return 0


def cmd_install(args):
    src = _zipapp_path()
    if not src:
        print("install works from the zipapp: python3 ce-devterm.pyz install", file=sys.stderr)
        return 2
    os.makedirs(args.dir, exist_ok=True)
    dst = os.path.join(args.dir, "ce-devterm")
    tmp = dst + ".tmp"
    shutil.copyfile(src, tmp)
    os.chmod(tmp, 0o755)
    os.replace(tmp, dst)
    print("installed %s" % dst)
    if args.dir not in os.environ.get("PATH", "").split(os.pathsep):
        print('add it to PATH: echo \'export PATH="%s:$PATH"\' >> ~/.profile' % args.dir)
    return 0


def _zipapp_path():
    here = os.path.abspath(__file__)
    marker = ".pyz" + os.sep
    if marker in here:
        return here.split(marker)[0] + ".pyz"
    a0 = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else ""
    if a0.endswith(".pyz") and os.path.isfile(a0):
        return a0
    return None


def cmd_doctor(args):
    ok_all = True
    color = _color_ok() and not args.mono

    def line(ok, what, detail=""):
        mark = ansi("ok", "ok  ", color) if ok is True else (ansi("fail", "FAIL", color) if ok is False else ansi("dim", "--  ", color))
        print("%s %-22s %s" % (mark, what, detail))

    py = sys.version_info
    line(py >= (3, 7), "python", "%s (%s)" % (platform.python_version(), sys.executable))
    line(None, "platform", "%s %s" % (platform.system(), platform.machine()))
    import locale
    enc = locale.getpreferredencoding(False)
    line(unicode_ok(), "locale", enc + ("" if unicode_ok() else " (UTF-8 recommended; use --ascii otherwise)"))
    term = os.environ.get("TERM", "")
    colors = None
    try:
        import curses
        curses.setupterm()
        colors = curses.tigetnum("colors")
    except Exception:
        pass
    line(True if (colors or 0) >= 8 else None, "terminal", "TERM=%s colors=%s%s" % (
        term or "-", colors, "" if sys.stdout.isatty() else " (not a terminal: the UI needs one, --headless does not)"))
    dev = printer_mod.DevTermPrinter()
    if os.path.exists(dev.path):
        line(dev.available(), "printer", dev.describe())
        line(None, "printer unicode", "TTF configured" if dev.unicode_ok() else "no TTF= in %s (Japanese labels print as boxes)" % printer_mod.DAEMON_CONFIG)
    else:
        line(None, "printer", "%s not found: receipts become PNG previews" % dev.path)
    pc = sound.player_command()
    line(True if pc else None, "audio", pc[0] if pc else "no aplay/afplay: beeps fall back to the terminal bell")
    sc = sound.speech_command()
    line(True if sc else None, "speech", sc[0] if sc else "no espeak (sudo apt install espeak) for the say op")
    opts = _options(args)
    ident = config.Identity.load(opts.identity_path)
    line(True if ident.paired else None, "pairing", ("paired as %s (%s)" % (ident.name, ident.device_id)) if ident.paired else "not paired (%s)" % opts.identity_path)
    server = opts.server
    if server is None and ident.server:
        try:
            server = config.parse_server(ident.server)
        except ValueError:
            server = None
    if server is None:
        line(None, "server", "not configured (--server MAC_IP)")
    else:
        from .pairing import Api, ApiError
        api = Api(server.http, timeout=4)
        try:
            h = api.health()
            line(True, "server", "%s %s mode=%s protocol=%s" % (server.display, h.get("version", "?"), h.get("mode", "?"), h.get("protocol", "?")))
        except ApiError as e:
            ok_all = False
            line(False, "server", "%s: %s" % (server.display, e))
            h = None
        if h is not None and ident.paired:
            try:
                me = api.me(ident.token)
                line(me is not None, "token", "valid" if me else "rejected: run `ce-devterm pair --force`")
            except ApiError as e:
                line(False, "token", str(e))
    return 0 if ok_all else 1
