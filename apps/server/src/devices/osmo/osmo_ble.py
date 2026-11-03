"""
ControlAnything: a dumb BLE pipe for the DJI Osmo Mobile bridge (written for this repo during the hackathon).

All DUML framing, safety limits and command logic live in TypeScript (osmo/*.ts). This helper only scans,
connects, subscribes to the gimbal's notify characteristic and moves bytes, speaking JSON lines:

  stdout  {"ev":"seen", name, address, rssi, uuids, dji}     scan result (scan mode, and while connecting)
          {"ev":"connected", name, address, mtu}           ready for tx
          {"ev":"rx", "hex": "55 ..."}                      one notification chunk
          {"ev":"log"|"error", "msg": "..."}  ·  {"ev":"closed"}  ·  {"ev":"scan-done", "count": n}
  stdin   {"op":"tx", "hex": "55 15 04 a9 ..."}             write (chunked to the MTU)
          {"op":"close"}

  python osmo_ble.py scan [--seconds 8]                     list advertisers; never connects
  python osmo_ble.py connect [--address A] [--name P]       connect to the first DJI gimbal (or that one)

Run through `uv run --no-project --with bleak==3.0.2 python osmo_ble.py ...` (bleak on macOS uses CoreBluetooth).
"""
import argparse
import asyncio
import json
import re
import sys

from bleak import BleakClient, BleakScanner

SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"
NOTIFY = "0000fff4-0000-1000-8000-00805f9b34fb"
WRITE = "0000fff5-0000-1000-8000-00805f9b34fb"
DJI_COMPANY_ID = 0x08AA  # SZ DJI Technology Co., Ltd. (Bluetooth SIG company identifier)
NAME_RE = re.compile(r"^(om|osmo|dji)", re.IGNORECASE)


def emit(ev, **kw):
    sys.stdout.write(json.dumps({"ev": ev, **kw}) + "\n")
    sys.stdout.flush()


def looks_like_gimbal(name, adv):
    uuids = [u.lower() for u in (adv.service_uuids or [])]
    dji = DJI_COMPANY_ID in (adv.manufacturer_data or {})
    return bool((name and NAME_RE.search(name)) or SERVICE in uuids or dji), uuids, dji


async def scan(seconds):
    found = await BleakScanner.discover(timeout=seconds, return_adv=True)
    n = 0
    for address, (dev, adv) in found.items():
        name = adv.local_name or dev.name or ""
        hit, uuids, dji = looks_like_gimbal(name, adv)
        emit("seen", name=name, address=address, rssi=adv.rssi, uuids=uuids, dji=dji, gimbal=hit)
        n += 1
    emit("scan-done", count=n)


async def find(address, name_prefix, timeout):
    def match(dev, adv):
        if address:
            return dev.address.lower() == address.lower()
        name = adv.local_name or dev.name or ""
        if name_prefix:
            return name.lower().startswith(name_prefix.lower())
        return looks_like_gimbal(name, adv)[0]

    return await BleakScanner.find_device_by_filter(match, timeout=timeout)


async def connect(address, name_prefix, timeout):
    dev = await find(address, name_prefix, timeout)
    if dev is None:
        emit("error", msg=f"no DJI gimbal advertised within {timeout:.0f} s (is it on, and not connected to the Mimo app?)")
        emit("closed")
        return
    closed = asyncio.Event()

    def on_disconnect(_client):
        closed.set()

    client = BleakClient(dev, disconnected_callback=on_disconnect, timeout=timeout)
    await client.connect()
    try:
        def on_notify(_char, data):
            emit("rx", hex=data.hex(" "))

        await client.start_notify(NOTIFY, on_notify)
        mtu = getattr(client, "mtu_size", 23) or 23
        wchar = client.services.get_characteristic(WRITE)
        if wchar is None:
            emit("error", msg="the gimbal has no FFF5 write characteristic (not an Osmo Mobile?)")
            return
        no_rsp = "write-without-response" in wchar.properties
        emit("connected", name=dev.name or "", address=dev.address, mtu=mtu, props=list(wchar.properties))
        chunk = max(20, mtu - 3)
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        while not closed.is_set():
            line_task = asyncio.ensure_future(reader.readline())
            close_task = asyncio.ensure_future(closed.wait())
            done, _ = await asyncio.wait({line_task, close_task}, return_when=asyncio.FIRST_COMPLETED)
            if close_task in done:
                line_task.cancel()
                break
            close_task.cancel()
            line = line_task.result()
            if not line:
                break  # parent went away
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("op") == "close":
                break
            if msg.get("op") == "tx":
                data = bytes.fromhex(msg.get("hex", ""))
                for i in range(0, len(data), chunk):
                    await client.write_gatt_char(wchar, data[i:i + chunk], response=not no_rsp)
    finally:
        try:
            if client.is_connected:
                await client.stop_notify(NOTIFY)
                await client.disconnect()
        except Exception as e:  # noqa: BLE001
            emit("log", msg=f"disconnect: {e}")
        emit("closed")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("--seconds", type=float, default=8)
    c = sub.add_parser("connect")
    c.add_argument("--address", default="")
    c.add_argument("--name", default="")
    c.add_argument("--timeout", type=float, default=15)
    a = ap.parse_args()
    try:
        if a.cmd == "scan":
            asyncio.run(scan(a.seconds))
        else:
            asyncio.run(connect(a.address, a.name, a.timeout))
    except KeyboardInterrupt:
        emit("closed")
    except Exception as e:  # noqa: BLE001
        emit("error", msg=f"{type(e).__name__}: {e}")
        emit("closed")


if __name__ == "__main__":
    main()
