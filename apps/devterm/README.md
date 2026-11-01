# ce-devterm: the DevTerm client

A terminal client for the ClockworkPi DevTerm. It pairs with the ControlEverything server on the Mac.
It shows the hacks the agent generated for your own devices, with value bars, beside an evidence tape
of what was sent and what the camera, mic or wire observed. It also works as a device: it prints
receipts on its thermal printer, beeps, speaks and changes its screen when the agent sends it an
`exec.command`.

It is a single Python zipapp that uses only the standard library. It runs on Python 3.7 and later,
so it works on the CM3's 32-bit Buster image: no pip, Node or compiler needed.

## Install on the DevTerm

On the Mac, build the zipapp (or use the committed `dist/ce-devterm.pyz`) and serve it for a minute:

```sh
python3 apps/devterm/scripts/build.py
python3 -m http.server 8765 --directory apps/devterm/dist
```

On the DevTerm:

```sh
curl -fsSLO http://<mac-ip>:8765/ce-devterm.pyz && curl -fsSLO http://<mac-ip>:8765/SHA256SUMS
sha256sum -c SHA256SUMS
python3 ce-devterm.pyz install           # -> ~/.local/bin/ce-devterm
ce-devterm doctor --server <mac-ip>      # Python, terminal, printer, audio, server
ce-devterm --server <mac-ip>             # first run pairs, then the terminal UI
```

`scp apps/devterm/dist/ce-devterm.pyz cpi@<devterm-ip>:` works too. Stop the HTTP server afterwards.
The server listens on plain HTTP/WebSocket port 8787 for clients like this one. Use it on a trusted
LAN only.

## Pairing

On first run the client asks the server for a device code (`POST /api/pair/start`, kind `devterm`,
capabilities `display speaker wifi local printer`). It then shows:

- a QR code (black on white half-blocks) that the Quest approves by looking at it;
- the passcode in big letters, which you can type on the Mac or the iPhone instead (or press `y` in
  the server terminal);
- on a DevTerm, a printed **pairing ticket** with the QR, the code and "CONTROL EVERYTHING · LINK
  REQUEST", so you can show the paper to the headset.

The client polls `GET /api/pair/status`. It stores the token in `~/.config/controleverything/device.json`
(mode 0600; `XDG_CONFIG_HOME` is respected) and connects to `ws://<mac>:8787/ws` with `hello`. Codes
expire after 5 minutes and are renewed automatically. If the server rejects the token (close 4401),
the client starts pairing again. `ce-devterm pair` pairs on the command line, and `ce-devterm unpair`
forgets the token.

## Screens and keys

| Screen | What it shows |
|---|---|
| HACKS · your devices | A numbered verb list for the selected device: `>` action, `(o)` control with a value bar, verdict ✓/✗ from the oracle. Disarmed hacks (not yet verified on the real device) are marked and refused. |
| EVIDENCE TAPE | One line per event: time · verb · device · command · state · measure · verdict, e.g. `SENT light dimmer SEEN -38 % lum ✓`. Green and red come only from an oracle. Model ids appear on agent steps. |
| DAEMONS · automations | Name, rate (≤ 3 Hz), state; pause/start/stop. |
| ROOM | Paired clients and identified devices, with links shown as `───` proven or `- -` not yet proven. |

The status line shows the link state and, while a Meta model call runs, its id and seconds
(`muse-spark-1.3 · 25 s`). On screens of 112 columns or more, HACKS and the tape share the screen.

Keys: `↑↓` select, `←→` adjust (`-`/`+` coarse), `⏎` or `1`–`9` upload (this key press is the human
confirmation; paper hacks ask `y` first), `[ ]` switch device, `u` undo, `:` type a command for the
agent ("make the light breathe"), `!` panic (asks `y`), `TAB` switch screen, `?` help, `q` quit.

The wire protocol: `control.event {widgetId, value, ts, specId, phase}`, where widgetId is the gen3d
control id, which equals the hack id. An action hack sends `value: true, phase: "end"`, and controls
send `start`/`move` at most 10 per second, then `end`. Typed commands (undo, daemon pause/stop) go out
as `voice.text {text, final: true}` to the server. Panic sends `panic`.

## Local executor

The client runs `exec.command` messages whose `executorDeviceId` is this device. It accepts
`x.exec.command` too, for testing through the hub.

| op | arg | On the DevTerm | On a Mac (`--demo`) |
|---|---|---|---|
| `print` | text, or `{title, lines[], device, hack, oracle, measure, verdict, rows[], models[], qr, contour, footer}` | a 32-column thermal receipt | a PNG of exactly those dots plus a `.txt`, shown as an overlay |
| `beep` | Hz, or `{freq, count, ms}` (≤ 3 Hz) | a WAV played through `aplay` | `afplay` |
| `say` | text | `espeak`, if installed | `say` |
| `screen` | `invert` · `#rrggbb` · `off` · `{text}` | one inversion (never flashing), a colour wash or a big word | same |
| `volume` | 0–100 | ALSA `amixer` | refused (`unsupported`) |

The client always replies with `exec.ack {execId, ok, sentAt, detail, error?, latencyMs}` to the server.
`sentAt` is when the bytes or sound went out. The ack never claims the effect happened, because only an
oracle may say that. Errors use the protocol codes (`unsupported`, `bad_args`, `no_port`, `timeout`,
`rate_limited`, `refused`). A panic drops queued jobs and stops sounds.

## Printer handling

- **Device**: `/tmp/DEVTERM_PRINTER_IN`, the socat pty that ClockworkPi's `devterm-printer` daemon reads
  in raw mode. The client opens it with `O_NONBLOCK | O_NOCTTY`, writes in 4 KiB pieces with
  `select()` back-pressure and a 30 s timeout, and holds `flock(/tmp/ce-devterm-printer.lock)` so two
  jobs never interleave.
- **Format**: receipts are rendered by the client as 384-dot raster images, using its own 5×9 bitmap
  font plus the QR code and a big passcode, and sent as `GS v 0`. They therefore look the same on paper
  and in the Mac preview, and need no printer font. The client sends only commands the daemon's parser
  knows (`ESC @`, `ESC a`, `ESC J`, `ESC !`, `DC2 #`, `GS v 0`): an unknown escape makes it swallow the
  next bytes. Images go out in strips of at most 600 rows, because the daemon's counters are 16-bit and
  its width limit is 48 bytes. Every job ends with about 15 mm of feed past the tear bar, and receipts
  are cut off at about 30 cm.
- **Japanese labels** (for example 全灯) are printed through the daemon's TrueType mode, but only when
  `/usr/local/etc/devterm-printer` has a valid `TTF=`. Otherwise they print as a box. `ce-devterm doctor`
  reports which case applies.
- **Low battery**: the daemon skips printing below 14 % battery. The ack's detail says so.
- `--density 0-15` sets the darkness. `--printer file` writes previews instead of printing, and
  `--printer none` disables printing. `ce-devterm print-test` prints a test receipt, and
  `print-test --sample-ticket` prints a pairing ticket.

## Run it on the Mac (demo)

```sh
npm run dev                                       # the server on :8787
python3 apps/devterm/dist/ce-devterm.pyz --demo   # 127.0.0.1:8787, separate demo identity
```

Requests from localhost are auto-approved. Add `--pair-via-lan` to pair through the Mac's LAN address
instead, which shows the real QR/passcode flow. In that case, approve the request from the companion
page or by typing `y` in the server terminal. The built-in self-test hacks (Print receipt, Beep pattern,
Say line, Flash terminal, Show word) run locally and are labelled as hand-written. To have the server
side drive the DevTerm without the agent loop:

```sh
python3 apps/devterm/scripts/send_exec.py --to devterm print '{"title":"RECEIPT","lines":["hello"]}'
```

`--headless` runs without curses: the executor plus the tape on stdout, for a service or SSH.

## Development

```sh
cd apps/devterm
make test        # unit tests (stdlib unittest; Python 3.7+)
make check       # + static Python 3.7 check (syntax and 3.8+ APIs)
make build       # + dist/ce-devterm.pyz and SHA256SUMS (reproducible: fixed timestamps)
make crosscheck  # dev: vendored QR encoder vs the JS qrcode package, module for module
```

`tests/test_contract.py` validates every message the client sends against the protocol's JSON Schemas
in `packages/protocol/json-schema/`. `python3 tests/screens.py 128 30` draws every screen as text,
without a terminal.

Third-party code: `src/ce_devterm/vendor/qrcodegen.py` is Project Nayuki's QR Code generator library
(MIT licence, header kept).
