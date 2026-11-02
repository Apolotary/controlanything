# ControlEverything

**Point your Quest at a device you own. An AI agent built on Meta's models learns to control it, proves every command by watching or hearing the device react, and only then hands you holographic controls, generated for that device, floating next to it.**

ControlEverything lets you control the devices you already own from a Meta Quest 3, with your hands or your voice: an infrared ceiling light, a USB synthesizer, the laptop on your desk. You look at a device and pinch it; an agent identifies it through the headset's passthrough camera, picks the cable or beam that reaches it (USB-MIDI through your Mac, or infrared from a pocket-sized IR node you paired), writes a driver, and tests every command on the real device while the camera or the microphone watches. Only the commands that were *seen* or *heard* to work become controls in the air; the AI does its work once, up front, and the knob you turn afterwards is plain, deterministic code.

**What you need:** a Meta Quest 3; a Mac on the same network (it runs the agent and speaks USB-MIDI); and, for infrared devices, an **IR node**: an M5Stack Cardputer (a ¥5,000 pocket computer with an infrared LED) running the firmware in this repo, plus a small IR receiver so it can learn your remote. No hardware at all? A **simulated room** runs the whole loop from this repository: see [Judge path](#judge-path-no-hardware).

Built for the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026), problem statement *Push the Frontier*, Indie Developer track. Everything in this repository was built during the hackathon.

<!-- TODO before submission: replace with the final YouTube link -->
**▶ 3-minute demo video:** _link coming Wednesday Nov 4_

<!-- TODO before submission: docs/hero.jpg = a headset POV frame of the holo dimmer under the real ceiling light -->
<p align="center"><img src="docs/hero.jpg" alt="A hand pinching a holographic dimmer ring under a real ceiling light; the verdict line reads: sent dimmer → light got 38 % darker ✓" width="900"></p>

---

## The problem

> *Push the Frontier: "give a machine a new capability… unlock a better way to understand and control a physical system… show us what becomes possible when these models meet the real world."*

Every physical device ships with its own interface, and the interface is the first thing to fail: remotes get lost, companion apps are discontinued, manuals vanish, physical controls are too small, too far away, or more than many people's hands can manage. The device still works; only the way in is broken. ControlEverything regenerates the interface on demand. The agent sees the device, picks the channel that reaches it, **proves the channel works by watching the device**, and hands you controls fitted to you, where your hands are, or by voice. No new smart hardware, no cloud account for the device, and the device outlives its app.

## How Meta's models are used

Every model the product calls at runtime is a Meta model on the Meta Model API, and each one has a distinct job. Model ids are printed on every screen and in the work log while a call runs (`agent.step` messages and `GET /api/muse/calls`). Latencies are live measurements from Nov 2, 2026.

| Model | Job in the loop | Measured |
|---|---|---|
| **`sam-3.1`** | **SCAN.** Text-prompted segmentation of one passthrough frame per device category (`ceiling light`, `electronic device`, `synthesizer`; device nouns only, never people). The mask says **where** controls pin and **which pixels** the camera oracle watches during verification. | 1.7–3.9 s per prompt, prompts run in parallel |
| **`muse-spark-1.3`** | **IDENTIFY** the masked crop into a structured DeviceCard (`json_schema`, low effort). **RESEARCH** with built-in `web_search` when the curated charts have nothing. **DRIVE:** write the declarative driver. **FORGE:** write the hack set and 3D controls, and edit them by voice ("make the resonance control a big red lever"). | identify ≈ 5 s · driver 7.8 s · forge 13–19 s · edit ≈ 5–12 s |
| **`muse-wonder-1.0`** | **DRIVE, third writer.** When two Spark drafts fail the server's validation, Wonder writes the driver (guarded by a token cap and a 60 s timeout). | 19.9 s in the driver benchmark |
| **`muse-voice-transcribe-1.0`** | **Voice.** Push-to-talk audio from the headset is transcribed on the server and routed: *scan*, *undo*, *stop everything*, a hack by name, or an edit of the current controls. | ≈ 2.6 s for a 2.5 s utterance |

No other model runs at runtime. The QR decoder, the JPEG codec, the IR codec and the camera/audio oracles are plain code. (Muse Image generated the project's design concept frames during planning; it is not called by the product.)

## The loop

**Words on the screen.** Every client uses the same five words: **SCAN** (look at the room), **PING** (show how each device is reached), **LINK** (open a channel to a device and prove it works), **HACKS** (the actions and controls generated for *your own* devices; "hack" in the life-hack sense) and **DAEMONS** (automations that link two devices, such as the light breathing with the synth's tempo).

```
SCAN ──▶ IDENTIFY ──▶ LINK ──▶ LEARN ──▶ DRIVE ──▶ VERIFY ──▶ FORGE ──▶ ARM ──▶ CONTROL
sam-3.1  muse-spark   wire     IR from   muse-spark  camera /  muse-spark  one tap  deterministic
         DeviceCard   check    the remote (wonder)   mic       hack set +  by you   < 50 ms on LAN
                                                   decides    3D controls
         ◀──────────── AI at compile time ─────────────────────────────▶ ◀── no model ──▶
```

**AI at compile time, deterministic runtime.** The models run only in the discovery loop, once per device. The control loop (pinch or voice → `control.event` → driver action → `exec.command` → MIDI, IR or a local op) is plain code with rate limits, under 1 ms of server time and no model in it. The agent sends nothing to a device you have not picked, and no control goes live before you tap again.

| Step | What happens |
|---|---|
| **SCAN** | The headset sends a passthrough frame + head pose. SAM 3.1 outlines the devices; each outline becomes a world anchor and a tag. A pairing QR in view approves that device's pairing (the headset pairs companions by looking at them). |
| **IDENTIFY** | Muse Spark turns the crop into a DeviceCard: name, maker/model (kept `unknown` unless legible text supports it), category, protocols, what companion it needs. |
| **LINK** | The server picks the paired client that can reach the device (MIDI, IR, local). For USB it cross-checks the camera's guess against the port name and the MIDI identity reply: `confirmed` / `consistent` / **`mismatch` → "wrong device, refused"**. If no client can do it, the HUD asks you to pair one ("needs a companion: Cardputer (IR)"). |
| **LEARN** | For a remote whose codes are not public (our Koizumi ceiling light), you press each button once in front of an IR receiver; each capture is stored as a hypothesis ("this is probably *brighter*"). Curated charts and code libraries (`apps/server/data/devices/`) cover the rest. |
| **DRIVE** | Muse Spark writes a **declarative driver** (actions with deterministic encodes, never executable code) from the research brief. The server validates it against allowlists: CC numbers from the chart, IR codes from the library or the learned captures, no SysEx writes, ranges, rate caps. Issues go back for repair; Wonder is the third writer; a curated template is the last resort and is labelled as such. |
| **VERIFY** | Every action runs once for real. The camera oracle compares frames before and after inside the SAM outline; the audio oracle compares feature windows of the synth's own audio. Two consecutive confirmations make a pass. Misses are reported as evidence, not hidden. |
| **FORGE** | Muse Spark writes the hack set (verb-first actions, continuous controls, daemons) bound to the verified actions; the server compiles it deterministically into the `ce.gen3d/1` 3D spec. Controls bound to unverified actions render **disarmed**. |
| **ARM** | A deliberate tap (pinch) from you before the generated controls go live; irreversible actions need a pinch-and-hold. (Your pinch on the device at SCAN is the go-ahead for VERIFY's one test per command.) |
| **CONTROL** | Pinch, twist, drag, or speak. Undo restores the previous value; panic stops everything. |

## The knob stays invisible until the device agrees

A command acknowledgement is never counted as success. The verdict comes from a sense, and it is named on screen: **seen** (camera), **heard** (microphone), **wired** (USB descriptor or MIDI identity) or **acked** (serial, for the IR node's "I sent it"; the camera still has to close the loop, because infrared is invisible).

- **Camera oracle:** mean luma inside the SAM outline versus a ring around it, so auto-exposure cannot fake a change; R/B ratio for colour temperature; a fixed-exposure absolute reading for dimmer steps. Deterministic, under 200 ms, no model.
- **Audio oracle:** RMS and spectral centroid of the synth's own USB audio (or the Mac's microphone) before and after a CC sweep, with a negative control (a CC the synth ignores must show no change).
- **Honest misses:** a code the light ignores reads `sent ✓ · seen ✗` and stays out of the controls. In the demo we block the IR beam with a hand on purpose: no reaction, no checkmark.

Measured in the simulated room on Nov 2 with live Meta models: **7 / 7** remote buttons learned, **8 / 8** driver actions verified by the camera (off −57 %, on +196 %, dimmer/brighter steps ±12–14 % in-mask luma against the ring), and the synth's CC actions verified by ear, with the negative-control CC correctly reported as no change.

> **Real-hardware status (Nov 2, morning JST):** the Cardputer → ceiling light, OP-1 Field CC and Quest camera-in-AR tests are scheduled for today's hardware session. Until this line is updated, treat the hardware path as unverified; the simulated room runs end to end.

## Judge path (no hardware)

The whole loop runs from this repository against a **simulated room**: a photo-real LED ceiling light with its IR remote and a synth that takes the same MIDI CC numbers as a Teenage Engineering OP-1 Field. The server, the agent and the Meta model calls are exactly the same as with real devices; only the transport is simulated, and the sim lamp obeys only its own synthetic code set, so a code from another brand produces the same honest miss a real lamp would.

```sh
npm install
cp .env.example .env     # optional: MODEL_API_KEY=... for live Meta models.
                         # Without a key the server runs in FIXTURE mode and replays recorded real responses.
npm run demo:sim         # builds what is missing, starts the server, prints the URLs below
```

1. **Open the sim room: <http://localhost:8787/sim/>** and click once (browsers allow audio only after a click). It pairs itself (localhost is trusted) and shows `PAIRED · ONLINE`. `?mute=1` keeps the synth off the speakers (the audio check still reads its analyser); `?autopress=1` makes the virtual remote press the button each learn prompt names, for an unattended run.
2. **Open the headset app: <http://localhost:8787/quest/>** (desktop emulation of the Quest 3; it uses the sim room as its passthrough view).
3. **SCAN**, then select the ceiling light (hover it and press `L`, or click it). SAM 3.1 outlines it, Muse Spark identifies it, the agent tries to link it: codes from other brands do nothing (`sent ✓ · seen ✗`), so it asks you to **press the highlighted button on the virtual remote**. The sim captures the press like an IR receiver, the agent replays the learned code, the camera sees the room brighten (`seen ✓`), the controls arm after your one-tap confirmation (click the ARM key, or press `A`; `H` stands in for pinch-and-hold on irreversible hacks). If the public library codes miss first, the agent asks for the remote again. Click a hack row and the lamp changes; `U` undoes. The ARM key waits two minutes; pinch the device again to be asked again, and a reloaded page gets its controls back the same way. `R` records a take and **Save take** keeps it in `apps/quest/public/takes/<take>/` for replay.
4. **The synth.** Select it; it answers the agent's MIDI identity request, plays the notes it sends, and every CC it gets changes the sound and its screen. The audio check reads the synth's own output.

Every model call, with id, latency and tokens, is listed at <http://localhost:8787/api/muse/calls>. The agent's work log is at `/api/agent/steps`, every op sent and its ack at `/api/agent/exec`, the state machine per target at `/api/agent/targets`. `npm run demo:sim -- --fixture` forces replay mode; `-- --live` forces live calls.

**Recorded runs.** `apps/server/fixtures/recorded/` holds real Meta responses (model id, latency, token usage, the answer text; never the prompt or the key) recorded with `MUSE_RECORD=1`. Fixture mode replays them and labels every result `FIXTURE (recorded from <model id>)`. Headset takes (`session.jsonl` + frames) replay through the live pipeline from `/sim/?take=<name>` (add `&autopress=1`: a headset take holds no remote presses, so the replaying sim has to press the buttons the learn prompts name) or in the Quest app with `?replay=<url>&replayMode=pipeline`. Two takes of the sim room are in `apps/quest/public/takes/` (a keyless FIXTURE run and a live run, both 8/8 verified). The whole repository's tests (`npm test`, 387 tests) include an end-to-end sim-mode run over the real WebSocket hub, and the committed recordings must replay to armed controls.

## Run it with hardware

What the demo uses: a Meta Quest 3, a MacBook running Chrome, an M5Stack Cardputer (original or Adv) with an M5 IR Unit on its Grove port, a KOIZUMI LED ceiling light with its KRH-TG-9A remote, and a Teenage Engineering OP-1 Field (firmware 1.7.0+) over USB-C. Optional: an iPhone and a ClockworkPi DevTerm.

1. **Server + Mac workbench.** `npm run dev`, then open <http://localhost:8787/companion/> in Chrome and allow MIDI (with SysEx), the microphone and serial when asked. The localhost page is the owner: it pairs itself and approves other devices.
2. **Cardputer (IR node).** `cd firmware/cardputer && pio run -e cardputer -t upload` (`-e cardputer-adv` for the Adv; hold **G0** while plugging in for the first flash over another firmware). Plug it into the Mac; the companion pairs it over Web Serial on its behalf. Details, pins and a standalone spike in [`firmware/cardputer/README.md`](firmware/cardputer/README.md).
3. **Quest.** Developer mode on, USB-C to the Mac, then `sh scripts/quest-grant-camera.sh` (grants the camera permission, sets up `adb reverse`, opens the app). Open `http://localhost:8787/quest/` in Quest Browser and **Enter AR**. Over the LAN instead: `https://<mac-lan-ip>:8443/quest/`, accept the self-signed certificate once.
4. **Synth.** Connect the OP-1 Field over USB-C with MIDI input enabled. The LINK step picks the port whose name and identity reply match what the camera saw.
5. **Other clients.** iPhone: open `apps/iphone/ControlEverything.xcodeproj`, run on the phone, scan the companion's QR or type the passcode. DevTerm: see [`apps/devterm/README.md`](apps/devterm/README.md) (a single Python 3.7 zipapp; prints its own pairing ticket).

### Dev setup and pairing

Requires Node 22.12+ (developed on Node 26) and Chrome on the Mac (Web MIDI, Web Serial).

```sh
npm install
cp .env.example .env        # MODEL_API_KEY for live Meta calls; leave it empty for FIXTURE mode
npm run dev                 # server (restarts on change) + companion and quest builds in watch mode
```

Other scripts: `npm run build`, `npm run typecheck`, `npm test`, `npm run smoke` (two WebSocket clients pair and exchange a `control.event` against the running server), `npm start` (no watch). The server listens on HTTPS/WSS `0.0.0.0:8443` (self-signed dev cert, for browsers on the LAN) and HTTP/WS `0.0.0.0:8787` (localhost, `adb reverse`, and microcontrollers that cannot do TLS; token-authenticated but unencrypted, so trusted LAN only, or set `HTTP_HOST=127.0.0.1`).

**Pairing** works like a headset's own device-code flow. Every unpaired client shows a QR code and a short passcode (`K7Q-4M2`); a trusted device approves it: the Quest by **looking at the QR** (the server decodes QR codes in scan frames), or you type the code on the Mac or the iPhone, or `y` in the server terminal. Approved clients get a long-lived token (only hashes are stored, in `apps/server/.data/space.json`; revoke with `DELETE /api/devices/:id`). Codes expire after 5 minutes and are single use. For CLI and firmware clients:

```sh
curl -s -X POST http://<mac>:8787/api/pair/start -H 'content-type: application/json' \
  -d '{"name":"Cardputer","kind":"cardputer","capabilities":["ir","display"]}'
# -> {pairingId, code, display:"K7Q-4M2", qr:"...", expiresAt, pollSecret, status:"pending"}
curl -s "http://<mac>:8787/api/pair/status?pairingId=<id>&pollSecret=<secret>"
# -> {status:"approved", deviceId, deviceToken}   (returned once; store it)
# then connect ws://<mac>:8787/ws and send {"v":1,"type":"hello","id":"1","ts":0,"from":"","payload":{"deviceToken":"…"}}
```

## Clients

All clients speak the same WebSocket protocol (`packages/protocol`, zod schemas that double as the Muse `json_schema`s) and see the same agent.

| Client | Form | Role |
|---|---|---|
| **Quest 3** (`apps/quest`) | WebXR app in Quest Browser (three.js, hand tracking) | The hub: passthrough camera frames + head pose, the SCAN HUD (outlines, tags, ping lines, work log with model ids), pinch-to-select, pairing by sight, push-to-talk voice, the generated 3D controls, record/replay of takes. Runs on the desktop in an emulator for the judge path. |
| **Mac workbench** (`apps/companion`) | Chrome web app at `/companion/` | Owner and approver; runs the drivers: Web MIDI to the synth (rate-limited, panic), Web Serial to the Cardputer, the audio oracle; shows the agent's steps with model ids, the generated driver, the evidence strip (GEN · CHECK · SEND · SEEN), links with their proof, daemons. |
| **iPhone** (`apps/iphone`) | SwiftUI, iOS 17+ | Companion and controller: pairing, the same hack lists as 2D controls, a handheld scanner and a second camera for verification, and its own hacks (torch, haptics, screen colour, speech). |
| **DevTerm** (`apps/devterm`) | Python 3.7+ stdlib-only zipapp (ClockworkPi DevTerm, or any terminal) | Terminal UI of hacks and an evidence tape; prints receipts of what was verified on its thermal printer, including its own pairing ticket. |
| **Cardputer** (`firmware/cardputer`) | PlatformIO firmware, M5Stack Cardputer and Cardputer-Adv | The IR node: sends raw or NEC/AEHA infrared at ≤ 4 frames/s, learns codes from a remote through an IR receiver, shows the pairing QR, a hack menu with physical keys, and an IR beam on every send. The screen never says "done"; the camera decides. |
| **Sim room** (`apps/sim`) | Web page at `/sim/` | Virtual ceiling light + IR remote + synth that pair like real devices and provide the camera frames and audio features the oracles read. |

## Safety

- **Allowlists.** A generated driver may only use CC numbers from the stored chart, IR codes from the library or the learned captures, and the local ops the executor declares. No SysEx other than the identity request. Drivers are data, never executable code.
- **Rate limits.** MIDI ≤ 200 messages/s, IR ≤ 4 frames/s, and anything that changes visible light ≤ 3 Hz (daemons default to 2 Hz; "no strobe" or "calm" in a voice request means ≤ 1 Hz). Nothing in the app, the video or the real room flashes faster than 3 Hz, and no red flashes.
- **Consent in the loop.** You pick a device with a pinch before the agent tests anything on it, and tap again (`arm.request` → `arm.confirm`) before its generated controls go live; pinch-and-hold for irreversible actions (printing). Undo for every action; a panic key that stops everything.
- **Devices, not people.** The camera is asked only for device categories (`ceiling light`, `synthesizer`, …); a server-side filter refuses person, face or hand prompts and drops any such label; nothing is ever drawn on a person.
- **Your own devices.** The agent drives only devices you selected, through companions you paired. Pairing needs approval from a trusted device; the Meta API key stays on the server and never reaches a browser, the firmware or the phone.
- For adults, on your own devices, on a trusted network. Not for anything safety-critical: no heaters, locks, vehicles or mains appliances.

## Built during the hackathon

Everything in this repository was written during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026): the headset app, the server and agent, the Mac workbench, the iPhone and DevTerm clients, the Cardputer firmware, the simulated room, the prompts and the device data. The commit history is the build log. Not built by us: the hardware (Meta Quest 3, Teenage Engineering OP-1 Field, a KOIZUMI ceiling light and its remote, M5Stack Cardputer, ClockworkPi DevTerm) and the open-source libraries and data below.

Architecture, protocol, oracles and measured numbers: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Per-component docs: [`apps/server/README.md`](apps/server/README.md), [`apps/sim/README.md`](apps/sim/README.md), [`apps/devterm/README.md`](apps/devterm/README.md), [`firmware/cardputer/README.md`](firmware/cardputer/README.md), [`apps/server/data/devices/README.md`](apps/server/data/devices/README.md).

## Licences and credits

Code in this repository: MIT licence.

Third-party data and assets, with their licences:

- **MIDI implementation charts and IR code tables** in `apps/server/data/devices/` were compiled from public sources during the hackathon; every entry cites its URL and a confidence label. Manufacturer documentation is quoted as facts (CC numbers, timings), not reproduced. [midi.guide](https://midi.guide) (pencilresearch/midi) is **CC-BY-SA-4.0** and is cited where used; Flipper-IRDB entries are **CC0**; SmartIR codes are **MIT**. The KOIZUMI remote has no public codes: they are learned from your own remote.
- **Fonts:** Chakra Petch and Share Tech Mono (SIL Open Font License, via `@fontsource`), JetBrains Mono (SIL OFL, Mac workbench only).
- **QR codes:** Project Nayuki's QR Code generator (MIT) vendored in the DevTerm client; `qrcode` (MIT) in the web clients; `jsqr` (Apache-2.0) for decoding pairing codes in scan frames.
- **Libraries:** three.js, zod, express, ws, Vite, IWER (MIT); `@meta-sam/parser` (Meta, see its licence); M5Unified, M5GFX, M5Cardputer, ArduinoJson (MIT); Arduino-ESP32 and IRremoteESP8266 (LGPL-2.1).
- **The simulated room** is a procedural Blender scene (primitives and procedural materials only) rendered once into light layers; no third-party assets.
- Model names are used descriptively. Not affiliated with or endorsed by Meta.
