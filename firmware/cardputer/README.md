# ce-cardputer: the IR node

Firmware for the **M5Stack Cardputer** and **Cardputer-Adv** that makes either one the
ControlEverything IR node:

- sends IR (raw timings, plus an on-device NEC / AEHA codec), at most 4 sends per second;
- learns IR from a remote through an IR receiver on the Grove port;
- shows the pairing QR and passcode, a hack menu with value bars, and an IR beam on every send;
- talks to the Mac companion over USB serial (JSON lines);
- runs the **G1 spike** on its own, so the ceiling light can be tested with no host software.

PlatformIO + Arduino-ESP32 2.0.17 (`espressif32@6.9.0`), M5Unified 0.2.20, M5GFX 0.2.27,
M5Cardputer 1.1.1, IRremoteESP8266 2.8.6, ArduinoJson 7.4.3.

## Hardware

| | Cardputer | Cardputer-Adv |
|---|---|---|
| IR LED (TX) | **G44** | **G44** |
| IR receiver | none built in | none built in |
| Keyboard | 74HC138 matrix | TCA8418 on I2C (G8/G9), polled by this firmware |

To **learn** codes, plug an **M5Stack IR Unit (U002)** (or any 38 kHz demodulating receiver)
into the Grove port: white wire = receiver → **G1**, yellow wire = the unit's IR LED → **G2**.
Unplug anything else from Grove first (for example Chain encoders). The unit's LED can also
transmit (`t` toggles LED G44 / Grove G2 in the spike; `"tx":"grove"` over serial).

The built-in LED is weak: aim the top edge of the Cardputer at the lamp's receiver window,
ideally from under 2 m. Test both LEDs from 1.5 m on day one.

## Build and flash

```sh
cd firmware/cardputer
pio run                                   # builds both envs
pio run -e cardputer -t upload            # original Cardputer
pio run -e cardputer-adv -t upload        # Cardputer-Adv
pio device monitor -e cardputer           # serial log (keeps DTR and RTS asserted)
sh test/run_host_tests.sh                 # IR codec tests on the Mac
python3 scripts/ir-spike.py selftest      # script codec check
sh preview/build.sh                       # render every screen to preview/out/*.png (needs SDL2 headers)
```

Both envs build the same code; the board is detected at runtime, so flashing the other
env still works (the env only sets the fallback board and the name in `hello`). Add
`--upload-port /dev/cu.usbmodem101` if several boards are plugged in.

**First flash over another firmware.** The user's boards currently run builds that put
USB in TinyUSB / host mode, so esptool cannot reset them by itself:

1. Switch the Cardputer off, unplug USB.
2. Hold the **G0** button and plug USB in, then release it. The screen stays black: that is ROM download mode.
3. Run the upload command above.
4. Unplug and replug **without** G0 (esptool's reset can leave the chip in download mode).

After this firmware is on the board, later uploads reset the chip by themselves (it uses
the S3's USB-Serial/JTAG port).

Optional backup of whatever is on the board first (about 95 s; `--no-stub` because stub
reads stall on this Mac):

```sh
esptool.py --chip esp32s3 --port /dev/cu.usbmodem101 --no-stub read_flash 0 0x800000 backup-$(date +%Y%m%d-%H%M%S).bin
```

Traps from earlier Cardputer projects, handled here:

- `/Volumes/macbook_ext` is HFS+ (1 s mtimes): after a quick edit, `sleep 1; touch src/*.cpp` before rebuilding.
- The Adv keyboard reports edges only: a key held through power-up is invisible. Boot shortcuts are "**press** during the splash".
- On the S3 USB-Serial/JTAG port, RTS high with DTR low resets the chip, and DTR high with RTS low arms download mode. Every host here keeps **both asserted**.

## G1 spike: test the ceiling light without the Mac

Turn the lamp **on** at the wall first, and stand under it with the Cardputer's top edge
pointing at the lamp.

1. Power on and **press `S`** while the splash shows (or press `S` on the IR NODE screen).
   `L` jumps straight to learning.
2. Pick a test:
   - **`1` LEARN + REPLAY** (needs the IR Unit on Grove). For each button (全灯, 消灯, 常夜灯,
     明るく, 暗く, 暖かい光, 白い光) the screen says `press 全灯`: press it on the Koizumi remote
     from about 10 cm, then press it **again** to confirm. A match is saved to NVS and the
     screen shows the waveform and the decoded format (for example `AEHA 40b T432 ... x2`).
     `Tab` skips a button, `Enter` keeps a single capture, `r` retries. Then the replay
     pass: `Enter` fires each learned code at the lamp, answer **`y`/`n`** to
     "light changed?". Order matters: OFF only shows if the lamp is on.
   - **`2` CANDIDATES** (no receiver). Other makers' OFF codes for CH1 to CH3 (Panasonic,
     NEC/HotaluX, Toshiba, Hitachi, Iris Ohyama, Takizumi, Odelic?). `Enter` fires, answer
     `y`/`n`; after a `y` the screen offers the matching ON code to confirm. `r` resends,
     `,` / `/` move between candidates. No code has ever been published for Koizumi
     remotes, so expect no hit and learn the remote instead.
   - **`3` REPLAY** the stored codes again, **`4` REMOTE** uses them: `,` dim, `/` brighter,
     `;` warmer, `.` cooler, `Enter` on/off, `n` night, `f` full, `o` off.
   - `t` switches the transmitter (built-in LED G44 / IR Unit LED G2), `` ` `` goes back.
3. Answers and learned codes stay in NVS across reboots and are logged on serial as
   `{"t":"spike",...}` and `{"t":"learned",...}` lines.

### The same from the Mac: `scripts/ir-spike.py`

Standard library only (uses pyserial if importable). It finds `/dev/cu.usbmodem*` itself.

```sh
python3 scripts/ir-spike.py hello            # board, firmware, chip id, stored codes
python3 scripts/ir-spike.py learn            # learn 7 buttons, saves spike-results/learned-*.json
python3 scripts/ir-spike.py replay spike-results/learned-<time>.json   # y/n per code
python3 scripts/ir-spike.py replay --slots   # replay what the device stored
python3 scripts/ir-spike.py try              # candidate walk: OFF, y/n, confirm ON
python3 scripts/ir-spike.py cands            # the candidate list and saved answers
python3 scripts/ir-spike.py send aeha "2C 52 09 2F 26" --unit 432 --repeats 1 --ask
python3 scripts/ir-spike.py monitor          # print every device line
```

Every answer is appended to `spike-results/spike-<date>.jsonl` (gitignored). Copy a good
learned file to `research/devices/koizumi-krh-tg-9a.learned.json` for the server and the
sim lamp.

## Serial protocol (v1)

USB CDC on the S3's USB-Serial/JTAG port: VID `0x303A`, PID `0x1001`. Open at 115200 (the
rate is ignored; never 1200), then assert **DTR and RTS together in one call**
(`port.setSignals({dataTerminalReady: true, requestToSend: true})`) and keep the port open.

One UTF-8 JSON object per line, `\n` terminated. The device accepts lines up to 8192 bytes
and emits lines up to 4096. Both sides ignore lines that do not start with `{` (the ROM
prints boot text). Every host command has `t` and `id` (≤ 24 chars) and gets **exactly one**
ack: `{"t":"ack","id":"…","ok":true,"ms":<device millis>}` or
`{"t":"ack","id":"…","ok":false,"err":"bad_json|unknown_type|bad_args|busy|unsupported|cancelled","msg":"…"}`.

### Host → device

| `t` | Fields | Ack |
|---|---|---|
| `hello` | `proto`, `host` | `proto`, `fw` (`ce-cardputer@0.1.0`), `board` (`cardputer` / `cardputer-adv`), `chip` (efuse MAC, 12 hex), `name`, `caps` (`ir`, `ir-rx`, `display`, `keys`, `speaker`), `rx` `G1`, `tx` `[G44, G2]`, `txDefault`, `codes`, `uptimeMs` |
| `ir` | `us` (or `rawUs`): mark/space µs starting with a mark, 2..1024 entries of 1..65000; `khz` 30..60 (38); `repeats` 0..5 = **extra** full frames; `gapMs` 0..500 (or `frameGapUs`) between frames; `label` (shown and logged); optional `tx` `led`/`grove`, `step` + `of` + `phase` `try`/`replay` (screen shows `LINK · try 7 / 36`). Instead of `us`: `slot` (a code stored on the device), `cand` + `part` `main`/`confirm` (a built-in candidate), or `protocol` `NEC`/`AEHA`/`IRIS` + `bytes` (`"2C 52 09 2F 26"`, send order, LSB-first) + `unitUs`, or NEC `address` + `command` | sent **after the last frame left the LED**, with `ms` and `entries`. Send starts are ≥ 250 ms apart: an early command waits; a second one while one is pending gets `busy`. A frame may last ≤ 0.5 s |
| `learn` | `on` (true), `timeoutMs` (30000), `label` (`全灯`), `step`, `of`, `slot` (store every capture under this name) | immediate. Then one `learned` event per capture, and `learnend` at timeout. `{"t":"learn","on":false}` stops |
| `panic` | | stops learning, drops a pending IR job (it is acked `cancelled`) |
| `pair` | `state` `pending` + `code`, `display`, `qr` (≤ 159 chars), `ttlMs`; or `approved` / `linked` + `name`; or `denied` / `expired` | shows the QR + code, or LINKED / DENIED / EXPIRED |
| `menu` (alias `ui`) | `title`, `items` (≤ 12: `id`, `key` (`1`, `a`, `enter`, `space`, `left`, `right`, `up`, `down`…), `label`, `armed`, optional `slot`), `bars` (≤ 3: `id`, `label`, `value` 0..1, optional `unit`, `steps` (dots), `lo`/`hi`, `big`), optional `local` (keys fire their `slot` on the device), `persist` (restored at boot) | shows the HACKS screen |
| `bar` | `bar`, `value` | updates one bar |
| `show` | `title`, `text`, `progress` 0..1, `tone` `ok`/`warn`/`bad`/`info`, `ms`; `style":"word"` = one word ≤ 8 chars at 48 px | overlay |
| `beep` | `hz` (2000..4000), `ms` (20..200), `count` (≤ 4, one per second) | |
| `codes` | | `codes`: stored slots with `slot`, `label`, `n`, `protocol`, `verified` |
| `cands` | | `cands`: the built-in candidate list with saved answers |
| `forget` | `slot`, or `all`, or `answers` | |
| `mode` | `idle` / `spike` / `menu` | |
| `ping` | | |

Unknown `t` → `err: "unknown_type"`; `app` → `unsupported` (not in v1).

### Device → host (no `id`)

| `t` | Fields |
|---|---|
| `hello` | the hello ack's fields, sent once at boot |
| `learned` | `us`, `khz`, `protocol` (and `proto`) `NEC`/`AEHA`/`UNKNOWN`, `bytes` + `bits` + `unitUs` + `checkOk` when decoded, `frames`, `sameFrames`, `frameGapUs`, `marks`, `durationUs`, `label`, `slot` + `stored`. One capture spans the whole press (both frames of a Panasonic-style remote and the gap), so replaying `us` with `repeats` 0 reproduces the press |
| `learnend` | `frames`, `reason` (`timeout` / `user`) |
| `pick` | `item`, `key`, `fired` (true if a local menu fired the code itself) |
| `key` | `key` for every key press |
| `spike` | `kind` `candidate` (`cand`, `part`, `protocol`, `bytes`, `answer`, `tx`) or `replay` (`slot`, `label`, `answer`, `tx`) |
| `pairreq` | `chip`: the user pressed `p` and wants a pairing code |
| `log` | `lvl`, `msg` |

Example session:

```
> {"t":"hello","id":"h1","proto":1,"host":"companion@0.2.0"}
< {"t":"ack","id":"h1","ok":true,"proto":1,"fw":"ce-cardputer@0.1.0","board":"cardputer","chip":"70041DD4E5C0",...}
> {"t":"ir","id":"x7","khz":38,"us":[9000,4500,562,562,...,562],"repeats":0,"gapMs":40,"label":"koizumi/off"}
< {"t":"ack","id":"x7","ok":true,"ms":81234,"entries":67}
> {"t":"learn","id":"l1","on":true,"timeoutMs":20000,"label":"全灯","step":1,"of":7,"slot":"full"}
< {"t":"ack","id":"l1","ok":true,"ms":81300}
< {"t":"learned","khz":38,"protocol":"AEHA","bytes":"…","bits":40,"unitUs":431,"frames":2,"sameFrames":1,"frameGapUs":74880,"marks":84,"label":"全灯","slot":"full","stored":true,"us":[3460,1720,…]}
```

## Screens (240 × 135)

Background `#0A0E12`, text `#F3F7FA`, cyan `#38F0FF` and volt `#EEFF41` accents, green / red
only for verdicts. Nothing flashes faster than 1 Hz: the send flash turns on at most once a
second and stays lit through faster bursts; the IR beam is motion, not a flash.

- **Boot**: wordmark, board and chip id, `S spike` / `L learn` for 1.8 s.
- **IR NODE**: `IR NODE · READY` with the link dot (cyan = host talking, volt = sending), the last
  command, codes stored, transmitter, a 200 × 8 send bar, key hints.
- **Pair**: full-height QR (dark on white, 2-module quiet zone, module size as large as the
  version allows) beside the code in two 40 px lines, a countdown and a 0.5 Hz dot; `c`
  shows the code alone at 48 px. Screen brightness goes to maximum for the camera. A short
  QR payload (for example `CE1:K7Q4M2`, QR version 1) gets 5 px modules; a 60-character URL
  gets 3 px, which the headset has to be much closer to read.
- **Hacks**: title, a big value numeral with its unit, a 200 × 8 bar, step bars as dots
  (`WARM ● ● ● ○ ○ COOL`), and a key legend; disarmed hacks are grey and cannot be picked.
- **Learn**: `LEARN · 3 / 7`, `press 常夜灯`, a volt bar that fills on capture, the waveform,
  `captured 68 marks` and the decoded format.
- **Sent**: every send draws three chevrons rising to the top edge (where the IR LED is) and
  prints `sent <label>` for a second; the screen never says "done" (the headset camera
  decides whether the light changed).
- **Word**: one word at 48 px, for the camera to read back.
