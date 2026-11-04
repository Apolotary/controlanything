# ControlAnything

**Pinch a device, ask Muse what your hands should do, and watch it write the connection.**

ControlAnything connects a Meta Quest 3 to supported hardware and software through a server on your laptop. Meta's SAM 3.1 outlines objects in passthrough. You select a device and ask what your hands should do. Muse Spark writes the device driver and a small JavaScript wiring program; you watch the source appear in AR while the server checks it. The wiring runs in a restricted Web Worker on the headset, sending validated actions to the device through the Mac bridge.

<!-- VIDEO_URL -->
**▶ 3-minute demo video:** _link coming soon_

<p align="center"><img src="docs/wiring-demo.png" alt="Current desktop emulator: requested fixture wiring in the code card, the visual synth and two-corner calibration guidance" width="800"><br><sub>Current desktop emulator during screen calibration, with requested code and its FIXTURE label visible. The scene is simulated; this is not real-headset or live-generation evidence.</sub></p>

Built for the **Meta Global AI Developer Hackathon** (Indie Developer track, *Push the Frontier*). The name nods to Meta's *Segment Anything*; this is an independent project, not a Meta product.

## The golden path

One MacBook and one Quest 3. The Mac runs the server, a paired companion and a silent full-screen **visual synth**. Its capability manifest describes what the instrument accepts; the hand-to-device wiring is generated after your request.

1. **Enter AR and find the Mac.** Pair with the companion's QR code or passcode. In Annotate, SAM 3.1 provides the outlines. Raise a flat left palm deliberately to open the wrist palette: **Annotate / Control**, **Electronics / Objects / All**, **Visual synth**, **Musical synth**, **Buddy**, **Stop** and **Exit**.
2. **Pinch the MacBook.** The companion opens its visuals. A setup ring shows the link, Muse-written driver, effect verification and interface preparation. A saved driver may be reused with its source disclosed. Driver prefetch is **off by default**; `CE_PREFETCH=1` is an opt-in rehearsal mode.
3. **Ask what your hands should do.** Choose **Touch the water**, **Hands as knobs** or **Surprise me**, or hold the card's microphone button and speak. The selected device has no hand interaction before this request. The optional dials are not a required step.
4. **Watch Muse write.** JavaScript streams into a code card beside the Mac and into the companion's code view. The server validates it, dry-runs synthetic signal traces in `node:vm`, and checks the driver actions it uses. The source is visibly **Live**, **FIXTURE** or **Template**.
5. **Calibrate for touch.** Follow the highlighted top-left then bottom-right screen corners, holding the fingertip still until each corner is captured. A hand-only program skips calibration. A saved screen plane is reused for that selected device when valid; **Recalibrate screen** is available.
6. **Touch the water.** After the program is ready and calibration completes, its Web Worker maps fingertip position to the visual synth's touch inputs. Touch and drag: ripples splash at the contact point and leave a wake. Lift away to release. There is no separate Perform step on this route.
7. **Stop.** Show both palms out, choose **Stop** from the wrist palette, or use `X` in the emulator. Ask again for a new interaction; Muse writes a new wiring program.

The deliberate palm menu closes after a selection and stays out of the way while the hands are controlling the device. Live hand feedback defaults to fingertips; optional hand outlines use `?hands=1`. Full joint tracking remains available for recording. Tutorial guidance and all control feedback live in AR. The [acceptance checklist](docs/DEMO-ACCEPTANCE.md) distinguishes emulator checks from the remaining real-Quest run.

**Optional musical route:** choose **Musical synth** to open **ControlAnything Synth**, a separate browser instrument on the paired Mac. It starts with sound locked; the present user must choose **Sound on** on that Mac. Complete setup, then ask Muse how your hands should play. Muse writes the note/gate and parameter mapping after the request; there is no built-in playable hand preset. The authored engine provides a two-octave C minor scale, filter, envelope, delay and three sound presets. Stop, closing/hiding the panel or disconnecting locks sound again. This route does not send physical MIDI. Its real-headset and audible acceptance remain pending; muted tests use `/companion/?mute=1`, independently of the server's `CE_MAC_SILENT` setting.

## Meta model calls vs. OS and browser features

**Every AI model this project calls at runtime is a Meta model**, called through Meta's Model API. The application does not call or bundle a non-Meta model. Platform tracking and system voices are described separately below.

| Meta model | What it does here |
|---|---|
| **SAM 3.1** (`sam-3.1`) | Finds and outlines the devices and objects in passthrough frames: every box you see comes from it. During verification it finds the same outline again on the before and after frames. |
| **Muse Spark** (`muse-spark-1.3`) | Identifies the pinched device from a crop and the whole frame. Writes the driver from the device's capability manifest or MIDI chart. Writes the per-request JavaScript wiring and control descriptions, with repair when checks fail. Also writes the Muse buddy’s text: it reacts to each object you show it and judges whether the object meets the quest. |
| **Muse Wonder** (`muse-wonder-1.0`) | Guarded fallback for driver or wiring generation when Muse Spark fails; only count it as used when a call actually occurred. |
| **Muse Image** (`muse-image-1.0`) | Paints the buddy's stickers. Optionally paints a device-inspired panel texture, which never delays the controls. |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Transcribes the device card’s hold-to-talk wiring request, plus the older lab assistant and spoken verification clips. |

These parts are OS or browser features, or plain code. None of them is an AI model call:

| Part | What it actually is |
|---|---|
| Hand and head tracking | Quest OS hand tracking, read through the WebXR Hand Input API. We read the joint poses and run no hand model of our own. |
| Hand/screen signals and UI gestures | Deterministic geometry on WebXR joints, with smoothing and a calibrated screen plane. Muse’s generated program decides how these signals drive the selected device. |
| An object you hold as a controller | Follows the hand that holds it (WebXR joints). SAM 3.1 finds it first. |
| Camera verification (*seen ✓*) | Deterministic before/after frame comparison inside the SAM 3.1 outline. |
| Passthrough frames | Quest Browser camera access (`getUserMedia`). |
| The Mac visual synth | A WebGL shader in Chrome. |
| The Mac musical synth | An authored Web Audio instrument in Chrome; sound requires an explicit Mac click. Muse writes its hand wiring, not the oscillator/effect engine. |
| Mac speech and music actions | macOS `say` and AppleScript (Music), which are OS features. They're off in the demo (`CE_MAC_SILENT=1`). |
| iPhone spoken replies | The iOS system voice (`AVSpeechSynthesizer`). |
| Device links | Web MIDI, Web Serial and Web Bluetooth (browser), bleak (Bluetooth LE), stored IR codes. |
| QR pairing | jsQR decoding (not a model). |

## What Muse writes, and where it runs

| Artifact | Generated from | Checked and executed where |
|---|---|---|
| **Driver** | The instrument’s capability manifest or reviewed device/MIDI data | Declarative operations validated on the server against supported transports, action IDs, CCs and ranges. Executors send those operations; driver JSON is not arbitrary executable code. |
| **Wiring program** | The wearer’s current request, available hand/screen signals and verified driver actions | Up to 4KB of JavaScript, validated and dry-run in a restricted `node:vm` context on the server. The accepted program runs every frame in a restricted **Web Worker on the Quest**. It never runs in the Mac companion. |
| **Labels/interface description** | Device actions and the request | Bound to validated actions and rendered in the app’s established AR layout. The current demo does not generate arbitrary 3D scene code. |

The wiring API is `wire(s, out, mem)`: read hand/screen signals, call `out.set(actionId, value)` or `out.trigger(actionId)`, and retain small state in `mem`. The runtime restricts actions, clamps values, rate-limits outputs and stops on repeated errors or a watchdog timeout. The server independently checks active wiring, arming and verification before dispatch. These are prototype guardrails, not a general-purpose untrusted-code platform.

Live generation is the normal keyed route. If generation fails, a **Template** fallback is visibly labelled *no Meta model wrote this*. No-key runs are **FIXTURE**, including chunked code playback. Driver-library reuse is labelled separately and does not mean the wiring was newly generated. Each new wiring request still asks for a new program; this path does not silently restore an old hand mapping.

After setup, each hand frame needs **no model call**: worker output → `control.event` (`wire:<actionId>`) → validated driver → Mac executor/renderer. See [architecture](docs/ARCHITECTURE.md) for the protocol and limits.

**Evidence boundary:** the earlier real-Quest dial/Perform build reached 81 fps at p95 and applied 100/100 commands in a November 4 run. A separate live Muse wiring probe streamed **Touch the water** in 14 deltas and reached ready in 8.1 seconds; **Hands as knobs** took about 11 seconds. These are separate measurements, not a measured end-to-end touch-water headset pass. The current ask → code → calibrate → touch route needs its own real-headset acceptance record.

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
- **Physical objects as controllers.** Once a device is armed, choose *Use an object* and pick a mug or bottle. SAM 3.1 finds it; once you pick it up it follows the hand that holds it (WebXR joints, One Euro filter). Lifting it drives the first control and sliding it drives the second. This is an earlier deterministic controller mode, not proof that Muse generated its hand-to-object behavior; it is outside the new wiring demo.
- **DJI Osmo gimbal.** A Bluetooth adapter for the Osmo Mobile: DUML framing, a safety envelope (≤ 90°/s, pan ±120°, tilt ±45°) and three links (`CE_OSMO=ble` via a small bleak helper, `web` via Chrome Web Bluetooth, `mock`). Server integration covers identify, link, driver and controls. Current evidence is mock/terminal testing, not a demonstrated headset-driven physical move. A physical move test is `npx tsx apps/server/scripts/osmo.ts test --move`.
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
3. **Click the laptop’s box.** Wait for setup, then choose **Touch the water** on the device card. The code view is labelled FIXTURE in a no-key run.
4. Follow calibration, then use the emulated tracked hand to touch the screen. The automated wiring check below supplies fingertip poses; ordinary mouse clicks are UI pinches, not physical screen contact. **Stop** is on the wrist palette or the `X` key. Keys: `G` Visual synth, `1/2/3` Electronics/Objects/All (Annotate only), `B` Buddy.

To see the real Mac app instead, open [the companion](http://localhost:8787/companion/) in a tab: it pairs, and pinching the screen opens its full-screen visuals. Model ids and latency are at [`/api/muse/calls`](http://localhost:8787/api/muse/calls). The agent's steps and evidence are at `/api/agent/steps` and `/api/agent/targets`.

**Automated check** (installed Chrome; its own muted fixture server, own data dir):

```sh
npm run build                         # only while no live AR session is using dist
PORT=8796 node scripts/e2e-judge.mjs   # current golden-path emulator check
node --import tsx apps/server/scripts/wire-e2e.ts  # fixture WIRE over WebSocket
```

These checks use server fixture detections. They do not measure detector accuracy, headset frame rate or the real Mac display.

## Run it with hardware

1. **Mac:** put `MODEL_API_KEY` in `.env` for live Meta models. Then run `npm run build`, then `CE_DEMO=1 CE_MAC_SILENT=1 npm start`. HTTP serves on :8787 and HTTPS on :8443.

2. **Quest 3** (developer mode, USB-C): `sh scripts/quest-grant-camera.sh` grants camera access and sets up `adb reverse`. In Quest Browser, open `http://localhost:8787/quest/` and choose **Enter AR**. Over the LAN, use `https://<mac-ip>:8443/quest/` and accept the development certificate.
3. **Companion:** open `http://localhost:8787/companion/` in its own Chrome window, full screen. Look at its QR code from the headset.
4. **Pinch the MacBook, then ask.** The companion becomes the visual synth. Choose a suggestion chip or hold-to-talk; watch the wiring code, calibrate if requested, then touch. Leave `CE_PREFETCH` unset for the normal on-demand demonstration.

While a live session is open, rebuild with `scripts/deploy-live.sh quest` (or `companion` / `sim`), which preserves old chunks. Reload the single Quest tab only after leaving AR; `scripts/quest-reload.mjs` avoids opening a duplicate camera-owning tab.

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

- **Meta:** the Quest 3 and its passthrough camera. SAM 3.1 and the Muse models via the Meta Model API. **@iwsdk/xr-input** (Immersive Web SDK input; owns all pointing, poke and pinch): MIT, © Meta Platforms, Inc. and affiliates. Hand and controller meshes from **@webxr-input-profiles/assets** (MIT, © Amazon; [notice](apps/quest/public/xr-profiles/LICENSE.md)). **@meta-sam/parser**: Meta's package licence.
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
