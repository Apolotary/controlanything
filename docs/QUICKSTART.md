# Quick start for reviewers

ControlAnything is a Meta Quest 3 passthrough app plus a small server on a Mac. You tag a real device in AR, ask what you want to do with it, and a Muse agent on the Mac writes, tests and deploys the code that connects them. Then it gives you controls in AR.

Pick the shortest path that fits what you have:

| You have | Path | Time |
|---|---|---|
| A Mac or PC with Node and Chrome | [A. No headset, no key](#a-no-headset-no-key-2-minutes) | 2 minutes |
| A Meta Model API key | [B. Live Muse](#b-with-a-meta-model-api-key-live-muse) | 5 minutes |
| A Meta Quest 3 and a USB-C cable | [C. On a Quest 3](#c-on-a-meta-quest-3) | 15 minutes |
| A webcam or a phone, no headset | [D. Camera in place of a headset](#d-no-headset-with-a-camera) | 5 minutes |

You need **Node 22.12 or newer** and **Google Chrome**. The server was developed on macOS. The Quest, Reels, OP-1 and gimbal demos need a Mac.

## A. No headset, no key (2 minutes)

```sh
git clone https://github.com/Apolotary/controlanything && cd controlanything
npm install
npm run demo:sim
```

`npm run demo:sim` builds any missing web apps, starts the server on port 8787 and prints the two links below. Keep the terminal open; Ctrl+C stops the server.

1. Open **`http://localhost:8787/sim/`** in Chrome. This simulated room stands in for your Mac. It pairs itself, and the laptop on its desk runs the visual synth.
2. Open **`http://localhost:8787/quest/?emulate=1&camera=sim&mic=0`** in a second tab. This is the Quest app in a desktop headset emulator. In the emulator, a click is a pinch, right-drag looks around, and W/A/D/Q/E move.
3. Choose **Enter AR (emulated)**. You start in **Annotate**: outlines from SAM appear around objects in the room.
4. **Click the laptop's outline** (it is labelled *ControlAnything Visual Synth*). This tags it. You stay in Annotate; nothing is wired yet.
5. Press **`M`** to switch to **Control** (or choose *Control* in the wrist menu at the right). Click the laptop again to open its card.
6. On the card, choose **Give me knobs for this**.
7. Watch the **code card** beside the laptop. Muse writes a connector file, starts it on the "Mac", tests it, and hands back an instrument: a water XY pad and coloured knobs. The card and the page header say **FIXTURE**. A FIXTURE run takes a second or two; then the card shrinks to a small pill.
8. Click a knob and drag it up. Each change goes to the visual synth on the sim laptop.
9. Press **`X`** to stop. The connector is shut down.

Other keys in the emulator: `G` opens the visual synth demo, `B` opens Buddy, `1`/`2`/`3` choose Electronics / Objects / All (in Annotate).

Skip the **Swipe my hand to scroll Instagram Reels** suggestion here unless you want it. It is not simulated: it opens Instagram in Google Chrome and presses keys on the Mac that runs the server.

**What FIXTURE means.** Without an API key, no AI model is called. SAM outlines, device names and the agent's tool calls are recorded or scripted replays, and every card says **FIXTURE**. The connector process, the MIDI path to the visual synth, the AR controls and Stop are real code running on your machine. A FIXTURE run shows the integration; it does not show live model quality.

Two pages show what happened, from the same machine:
- **`http://localhost:8787/api/muse/calls`**: every model call. In FIXTURE mode it says `"mode": "fixture"` and each entry has `"model": "fixture"`: no model was called.
- **`http://localhost:8787/api/agent/connectors`**: the connector Muse deployed, its entry file, actions and recent log lines (for example `→ CC21 …`), and which agent engine ran.

Add `-- --mute` (`npm run demo:sim -- --mute`) for silent, unattended playback. Normal demos play sound after the first click.

## B. With a Meta Model API key (live Muse)

1. Copy the example settings and add your key:

   ```sh
   cp -n .env.example .env     # -n: never overwrite an existing .env
   # edit .env and set:  MODEL_API_KEY=<your Meta Model API key>
   ```

   `.env` is in `.gitignore`. Never commit it, and never put the key in a URL or a web page. The server keeps the key and removes secret values from everything it sends to browsers.
2. Start the same demo. With a key in `.env`, it runs live:

   ```sh
   npm run demo:sim            # or force it: npm run demo:sim -- --live
   ```

   The terminal says `models LIVE Meta Model API`. If an older server is still running on port 8787, stop it first; the script reuses a running server.
3. Follow the same steps as in A.

What changes:
- The code card and the emulator page show **LIVE** instead of FIXTURE. The card's header names the model, for example *muse-spark-1.3 is wiring "…"*.
- SAM 3.1 outlines the sim room live, and Muse Spark writes a new connector for your request. Expect about 30–60 seconds from the ask to the controls.
- `/api/muse/calls` lists each call with the model id (`muse-spark-1.3`, `sam-3.1`, …), `"source": "live"`, latency and tokens. The server terminal prints one `[muse] …` line per call.
- You can ask for things the suggestions do not cover. In the emulator the microphone is off (`mic=0`); remove `&mic=0` from the URL to hold the card's mic button (or the `V` key) and speak.

Optional: `CE_AGENT_ENGINE=muse-code` runs Meta's Muse Code CLI as the agent instead of the built-in loop. It needs the CLI (`sh scripts/install-muse-code.sh`) and falls back to the built-in loop when the CLI is missing.

## C. On a Meta Quest 3

### Set up the Mac

```sh
cp -n .env.example .env           # set MODEL_API_KEY=... for live models (optional; without it, FIXTURE)
npm install
npm run build                     # once, before the first start
CE_DEMO=1 npm start               # sound on; add CE_OSMO=web for the gimbal
```

The server listens on HTTP 8787 and HTTPS 8443. Do not set `CE_MAC_SILENT`; the demo uses sound.

Open **`http://localhost:8787/companion/`** in Chrome on the Mac and keep it visible, ideally full screen. This is the Mac companion: it runs the visual synth, talks Web MIDI to USB synths and shows Muse's code.

### Connect the Quest

1. Put the Quest 3 in developer mode and connect it to the Mac with a USB-C cable.
2. Forward the port, so the Quest's `localhost:8787` reaches the Mac:

   ```sh
   adb reverse tcp:8787 tcp:8787
   ```

   If the passthrough camera does not start later, run `sh scripts/quest-grant-camera.sh --no-open` once. It grants Quest Browser the headset camera permission and sets up the same port forward.
3. In **Quest Browser**, open **`http://localhost:8787/quest/`**. Open it in one tab only.
4. Choose **Enter AR**. Allow the camera and the microphone when asked. Over USB the Quest counts as local and pairs by itself.

Without a cable, use `https://<mac-ip>:8443/quest/` on the same trusted network and accept the development certificate.

### Use it

- **Annotate** is where you start. SAM 3.1 outlines objects. Pinch an outline to tag it; you stay in Annotate. If a device has no outline, switch the filter from Electronics to Objects or All.
- **The wrist menu.** Raise your **left** hand, palm toward your eyes, and pinch for a moment (or hold the flat palm still for about half a second). It has Annotate / Control, Electronics / Objects / All, Ask Muse, More, Stop all and Exit (hold).
- **Control.** Choose *Control* in the wrist menu, then pinch the tagged object. Its card offers suggestions and **Hold to ask Muse**.
- **Ask.** Tap a suggestion, or hold the mic button and say what you want. Muse Voice Transcribe turns it into text.
- **Watch.** Muse's terminal and code stream into the card beside the device, and the Mac speaks its progress.
- **Stop.** **Stop Muse** on the card cancels a run. Both palms out stops the current controls. **Stop all** in the wrist menu stops everything.

If the card says the Mac companion is needed, choose **Connect Mac** and look at the QR code on the companion page.

### The five demos

| Demo | Before you start | What to ask |
|---|---|---|
| **Touch the water** (visual synth) | The companion page is open on the Mac. | Tag the laptop, choose Control and say *"I want to control the water with my finger"*. Muse opens the visual synth on the Mac and writes a touch program. Touch the laptop screen with your fingertip: the first touch finds the screen, then ripples follow your finger. (Or: wrist menu → More → **Demo: visual synth**, then **Touch the water**.) |
| **Instagram Reels** (a third-party app) | Google Chrome installed. Allow **Accessibility** for the app that runs the server (Terminal, iTerm or your editor): System Settings → Privacy & Security → Accessibility. | Tag the laptop, choose Control, tap **Swipe my hand to scroll Instagram Reels**. Muse opens Reels in Chrome and tests the arrow keys. Flick your right hand up or down to scroll. Without Accessibility, the connector says so instead of retrying. |
| **OP-1 Field** (USB-MIDI) | Plug the OP-1 into the Mac by USB. On the companion, choose **Allow USB MIDI** and accept Chrome's MIDI prompt. Turn on MIDI receive on the OP-1 itself (forum tip: shift + COM → MIDI). | Tag the OP-1, choose Control, tap **Give me knobs for this** or **Play it with my hands**, or say *"Play the OP-1 Field with fingers"*. |
| **DJI Osmo Mobile 4** (Bluetooth) | Start the server with `CE_DEMO=1 CE_OSMO=web npm start`. In Chrome on the Mac, open **`http://localhost:8799`**, choose **Connect gimbal**, pick the OM 4 and keep that tab open. USB-C on the OM 4 is power only. | Tag the gimbal, choose Control and say *"Gimbal finger steering"* or ask for pan and tilt. The bridge limits speed (90°/s) and range (pan ±120°, tilt ±45°). |
| **Buddy** (a virtual pet) | Nothing extra. | Wrist menu → More → **Buddy**. Wave, pet or high-five it. **Capture** a real object, check the photo, then **Show Buddy**: Muse Spark writes its reaction and Muse Image paints a sticker. |

### Record hand and head poses

Open **`http://localhost:8787/quest/?rec=1`**. Choose **Record take** before **Enter AR**, start the Quest's own video recorder (Meta button → Camera → Record video), do the demo, then exit AR to finish. Poses are recorded at up to 30 Hz (head plus 25 joints per hand). A take holds about 100 seconds with both hands tracked; the take saves automatically if it reaches the limit. **Save take** downloads a ZIP and also sends the take to the Mac, which keeps it in the server's data folder. Open the ZIP in **Motion lab** on the Mac at `http://localhost:8787/companion/tracking/`.

## D. No headset, with a camera

Open **`http://localhost:8787/quest/hands.html`** with the server from A or B running. It is the same golden path, AR view first:

1. **Start AR**. A laptop shows the webcam. Android Chrome starts WebXR AR. iPhone Safari uses the rear camera full screen and says it has no WebXR AR.
2. In **Annotate**, SAM outlines objects in the camera view. Tag one: tap it on a phone; on a webcam, hold your hand over it until the ring fills, or click it.
3. Switch to **Control**, select the tagged object, and tap a suggestion or hold the mic.
4. Muse's code streams beside the object. Controls appear pinned to it.

Without a key, SAM is a FIXTURE replay of the simulated room, so its outlines will not match your camera. For real outlines, start the server with a key (B).

Webcam hand tracking is classic computer vision (skin colour, background learning, blobs). It loads no AI model. A phone needs HTTPS for the camera: use `https://<mac-ip>:8443/quest/hands.html` with a certificate the phone trusts. Details and limits: [HANDS-DEMO.md](HANDS-DEMO.md). The Buddy-first camera page is `/quest/reviewer.html?buddy=1` ([REVIEWER-DEMO.md](REVIEWER-DEMO.md)).

## Where to look in the code

| Feature | Main files |
|---|---|
| Server start, settings, HTTP routes | `apps/server/src/index.ts`, `apps/server/src/config.ts`, `apps/server/src/app.ts` |
| WebSocket hub, pairing, secret redaction | `apps/server/src/hub.ts`, `apps/server/src/pairing/` |
| Meta Model API client, FIXTURE replays, call log | `apps/server/src/muse/` |
| SAM 3.1 outlines | `apps/server/src/scan/sam.ts`, `apps/server/src/agent/scan.ts` |
| The Muse agent (tools, prompt, finish checks) | `apps/server/src/agent/muse-agent.ts` |
| Muse Code engine (opt-in) | `apps/server/src/agent/muse-code-engine.ts` |
| Connector processes and the `ce.mjs` runtime | `apps/server/src/agent/connector-host.ts` |
| Ask → agent → controls routing | `apps/server/src/agent/wire.ts`, `apps/server/src/agent/index.ts` |
| Hand-program and 3D-scene checks | `apps/server/src/agent/wire-check.ts`, `apps/server/src/agent/scene-check.ts` |
| Generated instrument UI | `apps/server/src/agent/instrument-ui.ts`, `packages/gen3d/`, `apps/quest/src/gen3d/` |
| Headset app: modes, keys, golden path | `apps/quest/src/app/app.ts` |
| Device card, wrist menu, AR panels | `apps/quest/src/hud/v2/` (`device-card.ts`, `wrist-palette.ts`, `hand-dock.ts`, `instrument-panel.ts`) |
| Asks, suggestions, hand-program Worker, code card | `apps/quest/src/wiring/` (`controller.ts`, `runtime.ts`, `scene-runtime.ts`, `code-card.ts`) |
| Hand signals and screen touch | `apps/quest/src/gestures/` |
| Buddy | `apps/quest/src/buddy/`, `apps/server/src/buddy/` |
| Webcam and phone page | `apps/quest/hands.html`, `apps/quest/src/hands/` |
| Pose recording and Motion lab | `apps/quest/src/replay/`, `apps/companion/src/tracking/` |
| Mac companion (Web MIDI, visual synth panel) | `apps/companion/src/` |
| Visual synth and its capability manifest | `packages/vsynth/` |
| DJI Osmo gimbal bridge | `apps/server/src/devices/osmo/` |
| Simulated room | `apps/sim/` |
| Message schemas | `packages/protocol/src/` |

More: [ARCHITECTURE.md](ARCHITECTURE.md), [MUSE-HARNESS.md](MUSE-HARNESS.md), [HARDWARE-DEMO.md](HARDWARE-DEMO.md), [evidence/](evidence/README.md).

## Troubleshooting

- **"Port 8787 is already in use".** Another server is running. Stop it, or start on free ports: `HTTP_PORT=8796 HTTPS_PORT=0 npm run demo:sim`, then use `8796` in the links.
- **"ControlAnything needs Node 22.12 or newer".** Run `node -v` and install a current Node from nodejs.org.
- **No outlines in the emulator.** Open `/sim/` first and keep that tab open; it is the camera and the Mac.
- **The mic does nothing in Quest Browser.** Allow the microphone for the site (Quest Browser site settings), reload outside AR, or tap a suggestion instead.
- **Reels does not scroll.** macOS blocked key presses. Allow Accessibility for the app running the server, then ask again.
- **"Mac companion not connected".** Open `http://localhost:8787/companion/` in Chrome on the Mac and keep it visible. In the headset, choose **Connect Mac** and look at its QR code.
- **The gimbal does not move.** Start with `CE_OSMO=web`, open `http://localhost:8799` in Chrome, choose **Connect gimbal** and keep the tab open. If an old pairing is stuck, forget the OM 4 in Bluetooth settings and connect again.
- **The OP-1 gets no notes.** Choose **Allow USB MIDI** on the companion and turn on MIDI receive on the OP-1.
- **Two Quest tabs, or "Could not start video source".** Close every other ControlAnything tab in Quest Browser; two tabs fight over the camera.
