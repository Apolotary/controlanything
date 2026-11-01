#!/usr/bin/env python3
"""Fire ceiling-light IR codes from the Mac through the Cardputer IR node (G1 spike).

Talks to the ce-cardputer firmware over USB serial (JSON lines, see ../README.md).
Standard library only; uses pyserial when it is importable, else raw termios.

  python3 ir-spike.py hello              device info
  python3 ir-spike.py cands              the firmware's candidate codes (+ saved answers)
  python3 ir-spike.py try                walk the candidates: fire OFF, y/n, confirm with ON
  python3 ir-spike.py learn              learn the remote's buttons (IR Unit on Grove)
  python3 ir-spike.py replay FILE        replay a learned file, y/n per code
  python3 ir-spike.py replay --slots     replay the codes stored on the device
  python3 ir-spike.py send aeha "2C 52 09 2F 26" --unit 432 --repeats 1 --gap-ms 75
  python3 ir-spike.py send nec "82 6D BE 41"
  python3 ir-spike.py raw "9000,4500,562,..."
  python3 ir-spike.py codes              codes stored on the device
  python3 ir-spike.py monitor            print every line from the device

Every answer is appended to spike-results/spike-<date>.jsonl next to this folder.
Never sweep unknown command bytes: some makers use them to re-program a lamp's channel.
"""

import argparse
import datetime as dt
import glob
import json
import os
import select
import sys
import time
from pathlib import Path

try:  # optional
    import serial  # type: ignore
except Exception:  # pragma: no cover
    serial = None

HERE = Path(__file__).resolve().parent
RESULTS = HERE.parent / "spike-results"

LEARN_BUTTONS = [  # slot, label printed on the remote (inferred for the KRH-TG-9A), meaning
    ("full", "全灯", "FULL"),
    ("off", "消灯", "OFF"),
    ("night", "常夜灯", "NIGHT"),
    ("brighter", "明るく", "BRIGHTER"),
    ("darker", "暗く", "DARKER"),
    ("warmer", "暖かい光", "WARMER"),
    ("cooler", "白い光", "COOLER"),
]


# ---- IR codec (mirror of src/ir_codec.cpp; bytes in send order, LSB-first per byte) ----


def parse_hex(s):
    s = s.replace("0x", " ").replace("0X", " ")
    for sep in ",:-_\t":
        s = s.replace(sep, " ")
    out = []
    for tok in s.split():
        if len(tok) % 2 and len(tok) > 1:
            raise ValueError(f"odd hex token {tok!r}")
        if len(tok) == 1:
            out.append(int(tok, 16))
            continue
        out.extend(int(tok[i : i + 2], 16) for i in range(0, len(tok), 2))
    return out


def fmt_nec():
    return dict(header=[9000, 4500], one=(562, 1688), zero=(562, 562), trailer=562, msb=False)


def fmt_aeha(t=425):
    return dict(header=[8 * t, 4 * t], one=(t, 3 * t), zero=(t, t), trailer=t, msb=False)


def fmt_iris():
    return dict(header=[2076, 948, 5548, 964], one=(1500, 500), zero=(500, 500), trailer=500, msb=True)


def encode(fmt, data):
    us = list(fmt["header"])
    for b in data:
        for k in range(8):
            bit = (b >> (7 - k)) & 1 if fmt["msb"] else (b >> k) & 1
            us.extend(fmt["one"] if bit else fmt["zero"])
    if fmt["trailer"]:
        us.append(fmt["trailer"])
    return us


def encode_named(proto, hexstr, unit=425):
    data = parse_hex(hexstr)
    p = proto.lower()
    if p == "nec":
        return encode(fmt_nec(), data)
    if p in ("aeha", "kaseikyo"):
        return encode(fmt_aeha(unit), data)
    if p == "iris":
        return encode(fmt_iris(), data)
    raise ValueError("protocol must be nec, aeha or iris")


# ---- serial transport ----


def find_port():
    ports = sorted(glob.glob("/dev/cu.usbmodem*")) + sorted(glob.glob("/dev/ttyACM*"))
    if not ports:
        sys.exit("no Cardputer found (looked for /dev/cu.usbmodem* and /dev/ttyACM*); plug it in or pass --port")
    if len(ports) > 1:
        print(f"several ports {ports}, using {ports[0]} (pass --port to choose)", file=sys.stderr)
    return ports[0]


class Link:
    """Keeps DTR and RTS both asserted: on the ESP32-S3 USB-Serial/JTAG port, RTS with
    DTR low resets the chip and DTR with RTS low arms download mode."""

    def __init__(self, port):
        self.port = port
        self.buf = b""
        if serial is not None:
            s = serial.Serial()
            s.port = port
            s.baudrate = 115200
            s.timeout = 0
            s.dtr = True
            s.rts = True
            s.open()
            self.ser = s
            self.fd = None
        else:
            import termios

            fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            attrs = termios.tcgetattr(fd)
            attrs[0] = 0  # iflag
            attrs[1] = 0  # oflag
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[3] = 0  # lflag
            attrs[4] = attrs[5] = termios.B115200
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            import fcntl
            import struct

            fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("I", termios.TIOCM_DTR | termios.TIOCM_RTS))
            self.ser = None
            self.fd = fd
        self.seq = 0

    def write(self, obj):
        line = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if self.ser is not None:
            self.ser.write(line)
            self.ser.flush()
        else:
            view = memoryview(line)
            while view:
                try:
                    n = os.write(self.fd, view)
                    view = view[n:]
                except BlockingIOError:
                    time.sleep(0.002)

    def _read_some(self, timeout):
        if self.ser is not None:
            end = time.time() + timeout
            while True:
                data = self.ser.read(4096)
                if data or time.time() >= end:
                    return data
                time.sleep(0.005)
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return b""
        try:
            return os.read(self.fd, 4096)
        except BlockingIOError:
            return b""

    def lines(self, timeout):
        """Yield JSON objects from lines starting with '{' until `timeout` s pass quietly."""
        end = time.time() + timeout
        while True:
            while b"\n" in self.buf:
                raw, self.buf = self.buf.split(b"\n", 1)
                raw = raw.strip()
                if raw.startswith(b"{"):
                    try:
                        yield json.loads(raw.decode("utf-8", "replace"))
                    except json.JSONDecodeError:
                        pass
            left = end - time.time()
            if left <= 0:
                return
            self.buf += self._read_some(min(left, 0.1))

    def request(self, obj, timeout=3.0, on_event=None):
        self.seq += 1
        rid = f"s{self.seq}"
        obj = dict(obj, id=rid)
        self.write(obj)
        for msg in self.lines(timeout):
            if msg.get("t") == "ack" and msg.get("id") == rid:
                return msg
            if on_event:
                on_event(msg)
            else:
                show_event(msg)
        return {"t": "ack", "id": rid, "ok": False, "err": "timeout", "msg": f"no ack within {timeout}s"}


def show_event(msg):
    t = msg.get("t")
    if t == "log":
        print(f"  [device {msg.get('lvl')}] {msg.get('msg')}")
    elif t == "learned":
        print(f"  [learned] {describe_learned(msg)}")
    elif t in ("hello", "key", "pick", "spike", "learnend", "pairreq"):
        print(f"  [{t}] {json.dumps(msg, ensure_ascii=False)}")


def describe_learned(m):
    if m.get("bytes"):
        return f"{m.get('protocol')} {m.get('bits')}b T{m.get('unitUs')} {m['bytes']}  frames {m.get('frames')}  marks {m.get('marks')}"
    return f"{m.get('protocol')} {len(m.get('us', []))} timings, {m.get('marks')} marks, {m.get('durationUs', 0) // 1000} ms"


# ---- logging ----


def log(record):
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"spike-{dt.date.today().isoformat()}.jsonl"
    record = dict(record, at=dt.datetime.now().isoformat(timespec="seconds"))
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def ask(prompt, choices="yn", default=None):
    while True:
        a = input(prompt).strip().lower()
        if not a and default:
            return default
        if a and a[0] in choices:
            return a[0]


def check(ack, what):
    if not ack.get("ok"):
        print(f"  ! {what} failed: {ack.get('err')} {ack.get('msg', '')}")
        return False
    return True


# ---- commands ----


def cmd_hello(link, args):
    ack = link.request({"t": "hello", "proto": 1, "host": "ir-spike.py"})
    print(json.dumps(ack, indent=2, ensure_ascii=False))


def cmd_monitor(link, args):
    print("listening (Ctrl-C to stop)")
    try:
        while True:
            for msg in link.lines(1.0):
                print(json.dumps(msg, ensure_ascii=False))
    except KeyboardInterrupt:
        pass


def cmd_cands(link, args):
    ack = link.request({"t": "cands"})
    if not check(ack, "cands"):
        return
    for i, c in enumerate(ack["cands"], 1):
        saved = f"  saved {c.get('answer', '-')}/{c.get('confirmAnswer', '-')}" if c.get("answer") else ""
        unit = f" T{c['unitUs']}" if c.get("unitUs") else ""
        print(f"{i:2d} {c['id']:<11} {c['brand']:<19} CH{c['ch']} {c['what']:<7} {c['protocol']}{unit} {c['bytes']}"
              f"  (confirm {c['confirm']}: {c['confirmBytes']}) [{c['confidence']}]{saved}")


def fire(link, obj, label):
    ack = link.request(dict(obj, label=label), timeout=4.0)
    if check(ack, f"send {label}"):
        print(f"  sent {label}  (device ms {ack.get('ms')})")
        return True
    return False


def cmd_try(link, args):
    ack = link.request({"t": "cands"})
    if not check(ack, "cands"):
        return
    cands = ack["cands"][args.start - 1 :]
    total = len(ack["cands"])
    print("Turn the lamp ON first (wall switch). Aim the Cardputer's IR window at the lamp's receiver.")
    print("Lamps fade over ~3 s: watch for a few seconds before answering.\n")
    hits = []
    for idx, c in enumerate(cands, args.start):
        print(f"[{idx}/{total}] {c['brand']} CH{c['ch']} {c['what']}: {c['protocol']} {c['bytes']}  [{c['confidence']}]")
        a = ask("  Enter = fire, s = skip, q = quit: ", "sq\n", default="\n")
        if a == "q":
            break
        if a == "s":
            continue
        while True:
            fire(link, {"t": "ir", "cand": c["id"], "part": "main", "phase": "try", "step": idx, "of": total},
                 f"{c['brand']} {c['what']}")
            ans = ask("  did the light change? [y/n/r=resend]: ", "ynr")
            if ans != "r":
                break
        log({"kind": "candidate", "cand": c["id"], "part": "main", "bytes": c["bytes"], "answer": ans})
        if ans != "y":
            continue
        ans2 = "n"
        input(f"  HIT. Enter = fire the confirm code ({c['confirm']}: {c['confirmBytes']}) ")
        while True:
            fire(link, {"t": "ir", "cand": c["id"], "part": "confirm", "phase": "try", "step": idx, "of": total},
                 f"{c['brand']} {c['confirm']}")
            ans2 = ask("  did it react? [y/n/r=resend]: ", "ynr")
            if ans2 != "r":
                break
        log({"kind": "candidate", "cand": c["id"], "part": "confirm", "bytes": c["confirmBytes"], "answer": ans2})
        hits.append((c, ans2))
        if ask("  keep searching? [y/n]: ") == "n":
            break
    print("\nresult:")
    for c, a2 in hits:
        print(f"  HIT {c['id']} ({c['brand']} CH{c['ch']}): main worked, confirm {'worked' if a2 == 'y' else 'did not'}")
    if not hits:
        print("  no candidate moved the lamp. Learn the remote instead: python3 ir-spike.py learn")


def same_code(a, b):
    if a.get("bytes") and b.get("bytes"):
        return a["bytes"] == b["bytes"]
    ua, ub = a.get("us", []), b.get("us", [])
    if not ua or len(ua) != len(ub):
        return False
    return all(abs(x - y) <= max(200, x * 0.25) for x, y in zip(ua, ub))


def cmd_learn(link, args):
    buttons = LEARN_BUTTONS
    if args.buttons:
        want = args.buttons.split(",")
        buttons = [b for b in LEARN_BUTTONS if b[0] in want] + [(w, w, w.upper()) for w in want
                                                               if w not in [b[0] for b in LEARN_BUTTONS]]
    print("IR Unit on Grove (white = G1 receiver). Point the remote at it from ~10 cm.")
    print("Each button: press it once, then once more to confirm. Enter alone skips a button.\n")
    learned = []
    for i, (slot, ja, en) in enumerate(buttons, 1):
        print(f"[{i}/{len(buttons)}] press {ja} ({en})")
        ack = link.request({"t": "learn", "on": True, "timeoutMs": args.timeout * 1000, "label": ja,
                            "step": i, "of": len(buttons), "slot": slot})
        if not check(ack, "learn"):
            return
        first, got = None, None
        deadline = time.time() + args.timeout
        while time.time() < deadline and got is None:
            for msg in link.lines(0.5):
                if msg.get("t") == "learnend":
                    deadline = 0
                    break
                if msg.get("t") != "learned":
                    show_event(msg)
                    continue
                print(f"  captured: {describe_learned(msg)}")
                if first is None:
                    first = msg
                    print("  press it again to confirm")
                elif same_code(first, msg):
                    got = msg
                    print("  match: saved")
                    break
                else:
                    first = msg
                    print("  no match, press again")
        link.request({"t": "learn", "on": False})
        if got is None and first is not None and ask("  keep the single capture? [y/n]: ") == "y":
            got = first
        if got is None:
            print("  skipped")
            continue
        learned.append({"slot": slot, "label": ja, "meaning": en, "protocol": got.get("protocol"),
                        "bytes": got.get("bytes"), "bits": got.get("bits"), "unitUs": got.get("unitUs"),
                        "frames": got.get("frames"), "frameGapUs": got.get("frameGapUs"), "khz": got.get("khz", 38),
                        "rawUs": got.get("us")})
        log({"kind": "learned", "slot": slot, "label": ja, "protocol": got.get("protocol"), "bytes": got.get("bytes"),
             "marks": got.get("marks")})
    if not learned:
        print("nothing learned (is the IR Unit plugged into Grove?)")
        return
    out = Path(args.out) if args.out else RESULTS / f"learned-{dt.datetime.now():%Y%m%d-%H%M%S}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = {"remote": args.remote, "capturedAt": dt.datetime.now().isoformat(timespec="seconds"),
           "convention": "rawUs = mark/space microseconds starting with a mark; bytes in send order, LSB-first",
           "codes": learned}
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nsaved {len(learned)} codes to {out} (the device also keeps them in NVS)")
    print(f"next: python3 {Path(__file__).name} replay {out}")


def cmd_replay(link, args):
    if args.slots and args.file:  # argparse puts the first name into `file`
        args.names = [args.file] + list(args.names)
    if args.slots:
        ack = link.request({"t": "codes"})
        if not check(ack, "codes"):
            return
        items = [("slot", c["slot"], c.get("label") or c["slot"]) for c in ack["codes"]]
    else:
        doc = json.loads(Path(args.file).read_text(encoding="utf-8"))
        items = [("raw", c, c.get("label") or c.get("slot")) for c in doc["codes"]]
    if args.names:
        items = [it for it in items if (it[1] if it[0] == "slot" else it[1].get("slot")) in args.names]
    print("Replay each code at the lamp and say whether it changed. Order matters (OFF needs the lamp ON).\n")
    for i, (kind, ref, label) in enumerate(items, 1):
        name = ref if kind == "slot" else ref.get("slot")
        input(f"[{i}/{len(items)}] {name} ({label}): Enter = fire ")
        while True:
            if kind == "slot":
                obj = {"t": "ir", "slot": ref}
            else:
                obj = {"t": "ir", "us": ref["rawUs"], "khz": ref.get("khz", 38)}
            fire(link, dict(obj, phase="replay", step=i, of=len(items)), f"#{i} {name}")
            ans = ask("  did the light change? [y/n/r=resend]: ", "ynr")
            if ans != "r":
                break
        log({"kind": "replay", "slot": name, "label": label, "answer": ans})


def cmd_send(link, args):
    us = encode_named(args.protocol, args.bytes, args.unit)
    label = f"{args.protocol.upper()} {args.bytes}"
    fire(link, {"t": "ir", "us": us, "khz": 38, "repeats": args.repeats, "gapMs": args.gap_ms}, label)
    if args.ask:
        ans = ask("  did the light change? [y/n]: ")
        log({"kind": "send", "protocol": args.protocol, "bytes": args.bytes, "unitUs": args.unit, "answer": ans})


def cmd_raw(link, args):
    us = [int(round(float(x))) for x in args.timings.replace(" ", "").split(",") if x]
    fire(link, {"t": "ir", "us": us, "khz": args.khz, "repeats": args.repeats, "gapMs": args.gap_ms},
         f"RAW {len(us)}")


def cmd_codes(link, args):
    ack = link.request({"t": "codes"})
    if check(ack, "codes"):
        for c in ack["codes"]:
            print(f"  {c['slot']:<10} {c.get('label', ''):<8} {c['protocol']:<8} {c['n']:4d} timings  {c['verified']}")
        if not ack["codes"]:
            print("  (none)")


def selftest():
    nec = encode_named("nec", "82 6D BE 41")
    assert len(nec) == 67 and nec[:2] == [9000, 4500] and nec[3] == 562 and nec[5] == 1688
    aeha = encode_named("aeha", "2C 52 09 2F 26", 432)
    assert len(aeha) == 83 and aeha[0] == 3456 and aeha[1] == 1728
    iris = encode_named("iris", "C0 81 40 00 5B")
    assert len(iris) == 85 and iris[4] == 1500 and iris[8] == 500
    assert parse_hex("0x2C,0x52") == [0x2C, 0x52] and parse_hex("2C52092F26") == [0x2C, 0x52, 0x09, 0x2F, 0x26]
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port (default: first /dev/cu.usbmodem*)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hello")
    sub.add_parser("monitor")
    sub.add_parser("cands")
    p = sub.add_parser("try")
    p.add_argument("--start", type=int, default=1, help="candidate number to start from")
    p = sub.add_parser("learn")
    p.add_argument("--buttons", help="comma list of slots (default: full,off,night,brighter,darker,warmer,cooler)")
    p.add_argument("--timeout", type=int, default=20, help="seconds per button")
    p.add_argument("--out", help="output JSON (default: spike-results/learned-<time>.json)")
    p.add_argument("--remote", default="KOIZUMI KRH-TG-9A")
    p = sub.add_parser("replay")
    p.add_argument("file", nargs="?")
    p.add_argument("--slots", action="store_true", help="replay the codes stored on the device")
    p.add_argument("names", nargs="*", help="only these slots")
    p = sub.add_parser("send")
    p.add_argument("protocol", choices=["nec", "aeha", "iris"])
    p.add_argument("bytes", help='bytes in send order, e.g. "2C 52 09 2F 26"')
    p.add_argument("--unit", type=int, default=425, help="AEHA T in us (Panasonic 432)")
    p.add_argument("--repeats", type=int, default=0, help="extra full frames")
    p.add_argument("--gap-ms", type=int, default=75)
    p.add_argument("--ask", action="store_true", help="ask y/n and log it")
    p = sub.add_parser("raw")
    p.add_argument("timings", help="comma-separated mark/space us, starting with a mark")
    p.add_argument("--khz", type=int, default=38)
    p.add_argument("--repeats", type=int, default=0)
    p.add_argument("--gap-ms", type=int, default=40)
    sub.add_parser("codes")
    sub.add_parser("selftest")
    args = ap.parse_args()
    if args.cmd == "selftest":
        selftest()
        return
    if args.cmd == "replay" and not args.slots and not args.file:
        ap.error("replay needs a FILE or --slots")
    link = Link(args.port or find_port())
    print(f"port {link.port} ({'pyserial' if link.ser is not None else 'termios'})")
    if args.cmd != "monitor":
        info = link.request({"t": "hello", "proto": 1, "host": "ir-spike.py"}, timeout=4.0)
        if not info.get("ok"):
            sys.exit(f"no answer from the firmware: {info.get('msg')} (is ce-cardputer flashed?)")
        print(f"{info.get('name')} {info.get('board')} {info.get('fw')} chip {info.get('chip')} "
              f"codes {info.get('codes')} tx {info.get('txDefault')}")
    {"hello": cmd_hello, "monitor": cmd_monitor, "cands": cmd_cands, "try": cmd_try, "learn": cmd_learn,
     "replay": cmd_replay, "send": cmd_send, "raw": cmd_raw, "codes": cmd_codes}[args.cmd](link, args)


if __name__ == "__main__":
    main()
