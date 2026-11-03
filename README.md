# ControlAnything

**Look at a device, pinch it, and play it with your hands.**

ControlAnything connects a Meta Quest 3 to the hardware and software around you. What the headset sees goes to Meta's SAM 3.1, which outlines the devices in view. When you pinch one, a small server on your laptop asks Muse Spark to identify it, write a driver for it and build spatial controls on the spot, then checks that those controls really change the device before it hands them to you.

<!-- VIDEO_URL -->
**▶ 3-minute demo video:** _link coming soon_

<p align="center"><img src="docs/hero.jpg" alt="Desktop emulator, sim room: the laptop's visual synth armed, with two arc dials on the screen, the device card and the wrist palette" width="600"><br><sub>Desktop emulator, sim room: the Mac's visual synth armed. Two arc dials ride the screen; the card has Perform; the wrist palette has Visual synth · Buddy · Use an object · Stop · Exit.</sub></p>

Built for the **Meta Global AI Developer Hackathon** (Indie Developer track, *Push the Frontier*). The name nods to Meta's *Segment Anything*; this is an independent project, not a Meta product.

## The golden path

One MacBook and one Quest 3. The Mac is both the bridge and the device being played: it runs a silent, full-screen **visual synth**.

1. **Enter AR.** Passthrough plus a calm HUD. The headset pairs with the Mac by looking at the QR code on its companion page (or you type the code).
2. **Look at the MacBook.** A thin outline and a pill appear: *MacBook · pinch to control*.
3. **Pinch it.** A setup ring circles the screen while the agent runs: identify → driver → verify → controls.
4. **Play.** Two arc dials (Warp, Ripples) appear on the screen's edges, with a device card beside them. Pinch-drag a dial and the Mac's visuals follow.
5. **Perform.** Tap *Perform* on the card. Then a left fist is the clutch, and your right hand's height and depth drive the dials.
6. **Stop.** Open both palms toward the scene, or tap *Stop* on the wrist palette.

That is three deliberate actions: Enter AR, pinch, Perform. To open the **wrist palette**, turn your left palm toward your face. It holds *Electronics · Objects · All* (what to track), *Visual synth*, *Buddy*, *Use an object*, *Stop* and *Exit*.

## How Meta's models are used

Every server model call goes to Meta's Model API. The table lists only what the code calls at runtime.

| Model | What it does here |
|---|---|
| **SAM 3.1** (`sam-3.1`) | Segments devices in passthrough frames (outlines and boxes). During verification it finds the same outline again on the before/after frames. One live golden-path run made 24 calls. |
| **Muse Spark** (`muse-spark-1.3`) | Identifies the pinched device from a crop and the whole frame. Writes the driver from the device's capability manifest or MIDI chart. Forges the controls: a hack set compiled to 3D controls, with a repair round when checks fail. Also voices the Muse buddy: a reaction to each object you show it, and a judgement on whether the object meets the quest. |
| **Muse Image** (`muse-image-1.0`) | Paints the buddy's stickers. Optionally paints a device-inspired panel texture that never delays the controls (`GEN3D_SKIN=0` turns it off). |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Transcribes *Ask Muse* push-to-talk (a lab feature) and spoken verification clips. |

**Measured** (from the independent verification pass, `CE_DEMO=1`, desktop emulator):

| Mode | Pinch → controls armed |
|---|---|
| Live, cold | **29.0 s**: identify 8.2 s, driver 7.1 s, forge 7.8 s plus one forge repair 13.2 s. An earlier live probe took 41.9 s. |
| Live, with the prefetch | **1.2 s**, measured by the builder after the verification pass. With `CE_DEMO=1` the server asks Muse for the driver and controls as soon as a Mac advertises the renderer, then re-validates them on the pinch. |
| Fixture replay | **1.3 s**. |

After setup, moving a control makes **no model call**. A control event resolves to a validated driver action, then to a MIDI, IR or Bluetooth op, rate-limited, in under 1 ms on the server.

**YOLOX-Nano is the one non-Meta model.** It runs on the headset for instant boxes before SAM answers, at 12–13 fps and 15–19 ms per inference (WebGPU, measured in the emulator). The person class is dropped before boxes leave its worker.

## What Muse writes, and what the server checks

- **The driver.** The visual synth publishes a capability manifest: its CCs, programs, effects and the messages it rejects. Muse Spark writes the driver from that manifest. The server validates it against the manifest: allowlisted CCs, ranges, rate caps. Generated code is never executed.
- **The controls.** Muse writes a semantic hack set bound to verified actions. The server checks it and compiles it deterministically to 3D controls.
- **Fallbacks, always labelled.**
  - If Muse doesn't answer in time, a curated template stands in, and the step says *curated template used (no Meta model wrote this driver)*.
  - A forge failure says *template fallback*.
  - A saved driver comes back labelled *from the library*.
  - Recorded replies are labelled **FIXTURE**, together with the model they were recorded from.

## Honest verification

Every action is tried once before you get the control, and the HUD says how the result was known:

| Label | Meaning |
|---|---|
| **seen ✓** | The headset camera saw the change: before/after frames, mask vs ring, deterministic, no model. |
| **renderer ✓** | The camera did not see a change, so the Mac's renderer reports what it applied (*verified by renderer: warp …*). |
| **acknowledged ✓** | Only the executor's acknowledgement. The bytes went out; nothing confirmed the effect. |
| **not seen ✗** | Failed. That control stays locked. |

In emulator runs, the camera at about 1 m usually does **not** see the Mac's screen change. Those passes are *renderer ✓* or *acknowledged ✓*, and they say so. A send alone never counts as proof for a lamp or a synth that the camera or microphone can check.

## More than one synth

- **Muse buddy.** *Wrist palette → Buddy.* A small desk mascot gives you quests (*"Show me something green!"*). Hold up a real object and Muse Spark reacts to it. Muse Image paints a sticker for its shelf.
- **Physical objects as controllers.** Once a device is armed, choose *Use an object* and pick a mug or bottle. YOLOX tracks it, filtered with a One Euro filter. Lifting it drives the first control and sliding it drives the second. This is the same deterministic control path, with no model in the loop.
- **DJI Osmo gimbal.** A Bluetooth adapter for the Osmo Mobile: DUML framing, a safety envelope (≤ 90°/s, pan ±120°, tilt ±45°) and three links (`CE_OSMO=ble` via a small bleak helper, `web` via Chrome Web Bluetooth, `mock`). It is wired into identify, link, driver and controls. Status: verified against the mock. A physical move test is `npx tsx apps/server/scripts/osmo.ts test --move`.
- **Hand and head pose recording.** Record a take from the headset: passthrough video plus head and 25-joint hand poses at up to 30 Hz. On the Quest it is under `?lab=1`; in the emulator it is in the side panel. Review it in **Motion lab** (`/companion/tracking/`): video and 3D hands on one timeline, tracking gaps, *Export dataset* for physical-AI training data. See [tracking review](docs/TRACKING-REVIEW.md).
- **Other bridges.** These paths exist but are off the critical path, and physical acceptance is still pending:
  - an OP-1 Field over USB-MIDI (via the Mac companion);
  - an IR ceiling light via an M5Stack Cardputer;
  - iPhone, DevTerm and Cardputer clients that pair by QR code or passcode.

## Judge path (no hardware)

Needs **Node 22.12+** and **Chrome**. No API key: without one, the server replays recorded real responses, labelled **FIXTURE**.

```sh
npm install
npm run demo:sim            # builds what's missing; silent server with CE_DEMO=1 on :8787
```

1. Open **[the sim room](http://localhost:8787/sim/?mute=1)** first. It stands in for your Mac: it pairs itself on localhost, and the laptop on its desk runs the visual synth.
2. Open **[the desktop Quest emulator](http://localhost:8787/quest/?emulate=1&camera=sim&mute=1&mic=0)** and choose **Enter AR**. Click = pinch, right-drag = look, W/A/D/Q/E = move.
3. **Click the laptop's box.** The setup ring runs, then the arc dials and the card appear. Drag a dial and watch the sim's laptop screen change.
4. Click **Perform** on the card. **Stop** is on the wrist palette (lower right) or the `X` key. Keys: `G` Visual synth, `1/2/3` Electronics/Objects/All, `B` Buddy.

To see the real Mac app instead, open [the companion](http://localhost:8787/companion/) in a tab: it pairs, and pinching the screen opens its full-screen visuals. Model ids and latency are at [`/api/muse/calls`](http://localhost:8787/api/muse/calls). The agent's steps and evidence are at `/api/agent/steps` and `/api/agent/targets`.

**Automated check** (installed Chrome; its own muted fixture server, own data dir):

```sh
npm run build
PORT=8796 npm run e2e:judge      # Enter AR → pinch the screen → setup ring → armed dials → dial drag
                                 # changes the visuals → Perform with tracked hands → both palms = Stop
PORT=8798 npm run e2e:vsynth     # the explicit path: Set up → Enable controls → pixel change → Stop resets
```

These checks disable YOLOX and use server fixture detections. They do not measure detector accuracy, headset frame rate or the real Mac display.

## Run it with hardware

1. **Mac:** put `MODEL_API_KEY` in `.env` for live Meta models. Then run `npm run build`, then `CE_DEMO=1 CE_MAC_SILENT=1 npm start`. HTTP serves on :8787 and HTTPS on :8443.
2. **Quest 3** (developer mode, USB-C): `sh scripts/quest-grant-camera.sh` grants camera access and sets up `adb reverse`. In Quest Browser, open `http://localhost:8787/quest/` and choose **Enter AR**. Over the LAN, use `https://<mac-ip>:8443/quest/` and accept the development certificate.
3. **Companion:** open `http://localhost:8787/companion/` in its own Chrome window, full screen. Look at its QR code from the headset.
4. **Pinch the MacBook.** The companion becomes the visual synth by itself.

Checklist and recording guide: [docs/DEMO-ACCEPTANCE.md](docs/DEMO-ACCEPTANCE.md). Per-app notes:
- [server and pairing API](apps/server/README.md)
- [Mac companion](apps/companion/README.md)
- [sim room](apps/sim/README.md)
- [DevTerm](apps/devterm/README.md)
- [Cardputer firmware](firmware/cardputer/README.md)
- the iPhone project, `apps/iphone/` (iOS 17+)

Use your own devices on a trusted network; this is not for safety-critical equipment.

Development: `npm run typecheck`, `npm test`, `npm run build`.

## Architecture

Quest (WebXR, three.js) ⇄ WebSocket hub ⇄ one Node server on the Mac (Meta model adapters, agent, oracles, forge) ⇄ executors (Mac companion, sim, Cardputer, iPhone, DevTerm, Osmo bridge). The protocol, the agent state machine, the oracles and the generated-controls format are described in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Built during the hackathon

The application code, clients, firmware, prompts, device data and simulated room were built during the Meta Global AI Developer Hackathon, **Oct 26 – Nov 4, 2026**, for submission by Nov 5, 11:00 JST. The commit history is the build log. The hardware, the pretrained models and the third-party libraries and assets below were not built by us. The DJI Osmo gimbal adapter (`apps/server/src/devices/osmo/`) is new code written during the hackathon; it draws on public protocol research (below) and on the author's own earlier, private notes on the gimbal's Bluetooth protocol (March 2026, documentation only), from which no code is included.

## Credits and licences

Repository code: **MIT** ([LICENSE](LICENSE)). Versions and transitive dependencies are listed in `package-lock.json`.

- **Meta:** the Quest 3 and its passthrough camera. SAM 3.1 and the Muse models via the Meta Model API. **@iwsdk/xr-input** (Immersive Web SDK input; owns all pointing, poke and pinch): MIT, © Meta Platforms, Inc. and affiliates. **@meta-sam/parser**: Meta's package licence.
- **YOLOX-Nano**, Megvii: **Apache-2.0**. It is the one non-Meta model, used for on-device boxes only. [Model notice](apps/quest/public/models/LICENSE-yolox.txt). Runs on **onnxruntime-web** (MIT).
- **In-headset UI:** **@pmndrs/uikit**, **@pmndrs/uikit-horizon** (pmndrs' Horizon kit, after Meta's Reality Labs design system), **@pmndrs/uikit-lucide** and **@pmndrs/pointer-events**: MIT, © Bela Bohlender / pmndrs. **Lucide** icons: ISC.
- **Ideas, no code copied:**
  - Google **XR Blocks** ([google/xrblocks](https://github.com/google/xrblocks), Apache-2.0; Li et al., arXiv:2509.25504): glass panel colours, lazy-follow and appear timings, touch rules.
  - **NVIDIA XR AI** ([NVIDIA/xr-ai](https://github.com/NVIDIA/xr-ai)): the agent response contract (acknowledge after a delay, stream replies).
  - Our arc dials, setup ring, device card and hand rings are our own code.
- **DJI Osmo protocol references, no code copied:**
  - [alkersan/om-research](https://github.com/alkersan/om-research) (MIT);
  - the DUML dissectors in [o-gs/dji-firmware-tools](https://github.com/o-gs/dji-firmware-tools) (GPL-3.0, reference only).
  The optional Bluetooth helper runs **bleak** (MIT) through `uv`. DJI and Osmo are trademarks of SZ DJI Technology; not affiliated.
- **Fonts:** **SIL OFL-1.1**. Inter, Chakra Petch and Share Tech Mono come via **@fontsource**. The Quest also bundles JetBrains Mono and an Inter derivative for tabular numerals ([font notice](apps/quest/public/fonts/README.txt)).
- **Libraries:**
  - **three**, **troika-three-text**, **zod**, **express**, **ws**, **selfsigned**, **qrcode**, Vite, IWER and @iwer/devui: MIT.
  - **jpeg-js**: BSD-3-Clause. **jsqr**: Apache-2.0.
  - DevTerm: Project Nayuki's QR generator (MIT).
  - Firmware: M5Unified, M5GFX, M5Cardputer and ArduinoJson (MIT); Arduino-ESP32 and IRremoteESP8266 (LGPL-2.1).
- **Device data:** midi.guide / pencilresearch MIDI data (CC-BY-SA-4.0), Flipper-IRDB (CC0) and SmartIR (MIT). Manufacturer facts are transcribed; manuals are not reproduced. [Sources](apps/server/data/devices/README.md).
- **Sim room:** our own procedural Blender scene, with no third-party scene assets.

Model and product names are descriptive. This project is not affiliated with or endorsed by Meta, DJI, Teenage Engineering or Apple.
