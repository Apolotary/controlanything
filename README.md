# ControlAnything

**Tag a device you own. Choose to set it up. Meta's models generate controls, and a camera or microphone checks that the device actually reacts.**

A Meta Quest 3 WebXR app and a Node/TypeScript server on your Mac, built for the **Meta Global AI Developer Hackathon**, Indie Developer track, *Push the Frontier*. Control an infrared light, USB synthesizer or laptop through a paired bridge. No hardware? Start with the simulated room below.

<!-- VIDEO_URL -->
**▶ 3-minute demo video:** _link coming Wednesday Nov 4_

<p align="center"><img src="docs/hero.jpg" alt="Quest view of generated controls beside a ceiling light" width="900"></p>

## Two modes, chosen by you

1. **ANNOTATE** starts when you enter AR. On-device YOLOX draws fast boxes around nearby devices; SAM 3.1 adds device outlines, including lights. Choose **All / Lights / Electronics**. At most **6** detections appear, within **3 m** of the headset using estimated positions; people are excluded. Pinch a box to tag it. Muse Spark quietly names the device. Tagging never starts linking, learning or testing.
2. **CONTROL** starts only when you switch. Untagged boxes disappear. Tagged devices show **Ready**, **Needs setup** or **Not connected**. Open one device card; if a bridge is missing, it explains what to connect. **Set up control** starts:

   `link → learn/research → drive → verify (camera/mic) → forge → Enable controls`

   The server finds the connection, learns remote codes or consults device data, generates a declarative driver, tests its actions and builds controls from the verified results. Tap **Enable controls** to use them.

The interface has a mode bar, device outlines and one selected card with one main control and up to three buttons. Use a near poke or a ray and pinch. Panels stay placed in the room with gentle follow; **Details** holds logs and evidence.

**Device commands require a tagged device, Control mode, a connected bridge and your request.** A successful send is not proof: the camera must see a change or the microphone must hear one. Unverified actions stay disabled. **Stop** cancels setup, disarms controls, drops pending work and stops automations. Returning to Annotate closes the controls and cancels unfinished setup; completed controls remain armed for your next visit to Control.

## Judge path (no hardware)

Requires **Node 22.12+** (developed on Node 26) and **Chrome**. The sim provides a ceiling light, remote, synth, camera frames and audio features through the same protocol as physical devices.

```sh
npm install
cp .env.example .env        # optional MODEL_API_KEY for live Meta calls
CE_MAC_SILENT=1 CE_MAC_LOCAL=0 npm run demo:sim -- --fixture
```

Without a key, **FIXTURE** mode replays recorded responses, labelled with their original model. Omit `--fixture` to use the key, or pass `--live` to require live calls. The launcher builds missing web apps; `--build` forces a rebuild.

1. Open [the sim room](http://localhost:8787/sim/?mute=1&autopress=1) first. It pairs automatically on localhost. `mute=1` keeps speakers silent; `autopress=1` presses the virtual remote buttons requested during learning. Remove `autopress` to press them yourself.
2. Open [the desktop Quest emulator](http://localhost:8787/quest/?emulate=1&camera=sim&mute=1&mic=0) and choose **Enter AR**. In Annotate, point at the ceiling light and click or press `L` to tag it.
3. Switch to **Control** (`M` also switches modes), select the tagged light and choose **Set up control**. Watch learning and verification, then **Enable controls** (`A`). Move the control and watch the lamp respond. **Stop** (`X`) stops the run.

Automated checks need installed Chrome and built apps; they launch their own muted fixture servers and clean up afterward:

```sh
npm run build
npm run e2e:judge           # 12 phases: annotate → tag → setup → verify → enable → change light
npm run e2e:flows           # 18 phases: adds untag, offline/reconnect, mode return, placement, Stop, hand pinch
```

They use ports **8796/8446** and **8797/8447**, respectively. Screenshots and diagnostics go to `research/screens/v2-flow/` and `research/screens/v2-flows/`. These checks disable YOLOX and use server fixture detections; they do not establish detector accuracy, physical synth verification or headset frame rate.

Inspect `/api/muse/calls` for model ids, latency and tokens; `/api/agent/steps`, `/api/agent/exec` and `/api/agent/targets` show progress, commands and evidence. [Sim and replay details](apps/sim/README.md).

## Try it without hardware: the visual synth

The **ControlAnything Visual Synth** is a silent WebGL2 instrument: Warp bends a flowing field, and three pattern buttons change its appearance. Setup sends MIDI-style commands to a virtual output and verifies the laptop screen with the headset camera. No microphone, speaker or physical synthesizer is needed.

```sh
npm install
npm run build
MODEL_MODE=fixture CE_MAC_SILENT=1 CE_MAC_LOCAL=0 npm run start
```

Open [the sim room](http://localhost:8787/sim/?mute=1), [the visuals](http://localhost:8787/vsynth/), and [the Quest emulator](http://localhost:8787/quest/?emulate=1&camera=sim&mute=1&mic=0&yolo=0) in the same Chrome profile. Choose **Enter AR**, tag the laptop screen labelled **ControlAnything Visual Synth** in Annotate, switch to **Control**, then choose **Set up control**. Keep the screen in view while the camera checks the changes. Choose **Enable controls**, move **Warp**, try the patterns, and choose **Stop** to restore the default visuals. The fixture controls use an explicitly labelled local template; camera verification still measures the rendered screen.

For a real Quest looking at your Mac, keep [the paired companion](http://localhost:8787/companion/) open and choose **Open visuals** in its **Visual synth · Virtual · Ready** row. The virtual output appears automatically without MIDI permission; `/vsynth/` is the display, while the companion bridges its commands.

`npm run e2e:vsynth` runs this sequence in installed Chrome on isolated ports **8798/8448**. It checks camera verification, generated controls, a measurable pixel change inside the sim laptop screen, and Stop restoring the defaults. Screenshots and failure diagnostics go to `research/screens/vsynth/`. The first check is that the sim advertises the connected **ControlAnything Visual Synth** port and renders a nonblank laptop screen.

## How Meta's models are used

All server model calls use Meta's API. **YOLOX-Nano is the only non-Meta model**, running locally on the headset for preview boxes; its people class is dropped before boxes leave the worker.

| Model | Runtime job |
|---|---|
| `sam-3.1` | Device segmentation and camera verification outlines. |
| `muse-spark-1.3` | Names tagged devices, researches missing device data, writes and repairs drivers, generates and edits controls. |
| `muse-wonder-1.0` | Third driver writer when two Spark drafts fail validation. |
| `muse-image-1.0` | Optional device-inspired panel textures; never delays enabling controls. Disable with `GEN3D_SKIN=0`. |
| `muse-voice-transcribe-1.0` | Transcribes push-to-talk requests and speech verification clips. |

After setup, moving a control executes validated driver data with rate limits, without a model call. Voice transcription and edits still use models. Drivers use allowlisted MIDI CCs, learned/library IR codes or declared local operations; generated code is never executed. [Architecture, protocol and verification](docs/ARCHITECTURE.md).

## Run it with hardware

1. **Mac:** `npm run dev`; open [the companion](http://localhost:8787/companion/) in Chrome. Enable MIDI, Cardputer serial or microphone as needed. The localhost browser is the owner and approves pairing codes.
2. **Quest 3:** with developer mode enabled and USB-C connected, `sh scripts/quest-grant-camera.sh` grants camera permission and sets up USB forwarding. Open `http://localhost:8787/quest/` in Quest Browser and **Enter AR**. LAN alternative: `https://<mac-lan-ip>:8443/quest/` (accept the development certificate).
3. **Synth:** connect an OP-1 Field over USB-C with MIDI input enabled. Setup cross-checks the port name and MIDI identity against the identified device.
4. **IR light:** flash a Cardputer with `cd firmware/cardputer && pio run -e cardputer -t upload` (`cardputer-adv` for Adv; hold **G0** during first connection when replacing firmware). Connect it to the Mac and attach an IR receiver to learn your remote. [Firmware and wiring](firmware/cardputer/README.md).

[Mac companion](apps/companion/README.md), [server and pairing API](apps/server/README.md), [DevTerm](apps/devterm/README.md); the iPhone project is `apps/iphone/ControlEverything.xcodeproj` (iOS 17+). Pair other clients with their QR code or passcode. Use your own devices on a trusted network; this is not for safety-critical equipment. Physical hardware results require a hardware session; the fixture checks demonstrate the simulated path.

Development checks: `npm run typecheck`, `npm test`, `npm run build`. `npm start` runs without watch; `npm run smoke` checks pairing and message relay against a running server. Default HTTP/WS is **8787**, HTTPS/WSS **8443**; override with `HTTP_PORT` / `HTTPS_PORT`.

## Built during the hackathon

The application code, clients, firmware, prompts, device data and simulated room were built during the Meta Global AI Developer Hackathon, starting Oct 26, 2026, for submission by **Nov 5, 11:00 JST**. The commit history is the build log. Hardware, pretrained models and third-party libraries/assets below were not built by us.

## Licences and credits

Repository code: **MIT**. Direct npm runtime dependencies are listed here; versions and transitive dependencies are in `package-lock.json`.

- **YOLOX-Nano**, Megvii: **Apache-2.0**, bundled local detector; [model notice](apps/quest/public/models/LICENSE-yolox.txt). **onnxruntime-web:** MIT.
- **three** (three.js), **troika-three-text**, **zod**, **express**, **ws**, **selfsigned**, **qrcode:** MIT. **jpeg-js:** BSD-3-Clause. **jsqr:** Apache-2.0. **@meta-sam/parser:** Meta's package licence (`SEE LICENSE IN LICENSE` in the lockfile).
- **Fonts:** Inter in the current Quest HUD and Mac companion; Chakra Petch and Share Tech Mono in the Quest launcher/legacy renderer and sim. All supplied by **@fontsource**, **SIL OFL-1.1**. The Quest also bundles an Inter derivative for tabular numerals; [font notice](apps/quest/public/fonts/README.txt).
- **Development/emulation:** Vite, IWER and @iwer/devui (MIT). **DevTerm:** Project Nayuki's QR generator (MIT). **Firmware:** M5Unified, M5GFX, M5Cardputer, ArduinoJson (MIT); Arduino-ESP32 and IRremoteESP8266 (LGPL-2.1).
- **Device data:** [source URLs and provenance](apps/server/data/devices/README.md); midi.guide / pencilresearch MIDI data (CC-BY-SA-4.0), Flipper-IRDB (CC0), SmartIR (MIT). Manufacturer facts are transcribed, not manuals reproduced. Unknown remote codes are learned from your remote.
- **Sim room:** our procedural Blender scene, with no third-party scene assets. Model names are descriptive; not affiliated with or endorsed by Meta.
