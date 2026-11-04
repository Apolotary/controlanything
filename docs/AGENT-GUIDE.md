# Guide for AI coding agents

Read this before you change code in this repository. It lists what the project is, how to run and test it, the rules that must not break, and the mistakes that have already cost time.

ControlAnything is a Meta Quest 3 passthrough WebXR app plus a Node server on a Mac. The wearer tags a real device in AR and asks what they want to do with it. A **Muse agent** in the server writes, deploys and tests a connector program for that device, then returns AR controls and, if asked, a hand program. The project's job is the AR interface and the server. **The connection code is written by Muse at runtime, after the wearer asks.** For reviewers, the shorter guide is [QUICKSTART.md](QUICKSTART.md).

## Repo map

| Path | What it is |
|---|---|
| `apps/server` | Node (Express + `ws`), run from TypeScript source with `tsx`. HTTP on 8787, HTTPS on 8443. Meta model adapters (`src/muse/`), the WebSocket hub and pairing (`src/hub.ts`, `src/pairing/`), SAM scanning (`src/scan/`), the Muse agent and connector host (`src/agent/`), device bridges (`src/devices/`, including the DJI Osmo bridge in `src/devices/osmo/`), Buddy (`src/buddy/`). Recorded replies for FIXTURE mode are in `fixtures/recorded/`. |
| `apps/quest` | The headset app: WebXR, three.js, Vite. `src/app/app.ts` is the main flow; `src/hud/v2/` the AR interface; `src/wiring/` asks, the hand-program Worker and the code card; `src/gestures/` hand signals; `src/buddy/` Buddy; `src/hands/` and `hands.html` the webcam/phone page. Built into `apps/quest/dist`, served at `/quest/`. |
| `apps/companion` | The Mac page in Chrome (`/companion/`): pairing, Web MIDI and Web Serial executor, the full-screen visual synth, the musical synth, Motion lab (`/companion/tracking/`). |
| `apps/sim` | A simulated room and Mac for the emulator and the e2e checks (`/sim/`). |
| `apps/iphone`, `apps/devterm`, `firmware/cardputer` | Other clients that pair with the server. Not on the main demo path. |
| `packages/protocol` | zod schemas for every WebSocket message (`wire.request`, `wire.progress`, `wire.ready`, `control.event`, …). |
| `packages/vsynth` | The visual synth: state, WebGL renderer and the capability manifest that Muse reads. |
| `packages/gen3d` | The `ce.gen3d/1` generated-controls format, validator and archetypes. |
| `scripts/` | e2e checks, live-deploy and Quest helpers. |
| `docs/` | Architecture, demo procedures and evidence. |

## Run it

Node 22.12 or newer. `npm install` at the root installs every workspace.

**A test server (FIXTURE, no credits).** Use your own port and your own data directory:

```sh
HTTP_PORT=8796 HTTPS_PORT=0 CE_DATA_DIR=$(mktemp -d) MODEL_MODE=fixture MODEL_API_KEY= \
  CE_DEMO=1 CE_MAC_SILENT=1 CE_OSMO=mock node --import tsx apps/server/src/index.ts
```

Then open `http://127.0.0.1:8796/sim/?mute=1` first (the simulated Mac and camera), and the headset emulator at `http://127.0.0.1:8796/quest/?emulate=1&camera=sim&mute=1&mic=0`. Emulator keys: click = pinch, right-drag = look, `M` Annotate/Control, `G` visual synth demo, `B` Buddy, `1`/`2`/`3` filters, `X` Stop.

`npm run demo:sim` is the reviewer's version of the same thing on port 8787. It honours `HTTP_PORT` and `CE_DATA_DIR`, and takes `-- --fixture`, `-- --live` and `-- --mute`.

**The live server** (the one a headset uses), from the repo root:

```sh
CE_DEMO=1 npm start                  # sound on; add CE_OSMO=web for the gimbal page on :8799
```

Leave `CE_MAC_SILENT` unset for demos. Restart it after changes in `apps/server` or `packages/protocol`. Changes in `apps/quest`, `apps/companion` or `apps/sim` need a rebuild, not a restart (see below).

**Build without breaking open pages.** `npm run build` empties `apps/*/dist`. A page that is already loaded then cannot lazy-load its chunks. While anyone uses the live server:

```sh
scripts/deploy-live.sh quest         # or companion | sim: builds to a temp dir, then copies over dist, keeping old chunks
```

For tests, build into a scratch directory and point your test server at it:

```sh
(cd apps/quest && npx vite build --outDir /tmp/ce-stage-quest --emptyOutDir)
CE_QUEST_DIST=/tmp/ce-stage-quest PORT=8798 node scripts/e2e-muse-agent.mjs
```

`CE_COMPANION_DIST` and `CE_SIM_DIST` work the same way.

## Fixture and live modes

| Mode | When | What happens |
|---|---|---|
| **LIVE** | `MODEL_API_KEY` is set in `.env` (or `MODEL_MODE=live`) | Real Meta model calls. Each is logged at `GET /api/muse/calls` and as a `[muse] …` line in the server log. |
| **FIXTURE** | No key, or `MODEL_MODE=fixture` | No model is called. SAM and identification replies replay from `apps/server/fixtures/recorded/`; the agent's tool calls come from a scripted run (`fixtureScript()` in `muse-agent.ts`). The tools, the connector process, MIDI routing, the AR controls and Stop still run for real. Everything is labelled **FIXTURE**. |
| **TEMPLATE** | Only in the older `CE_AGENT=0` flow, when Muse could not finish | Hand-written code, labelled *Template: no Meta model wrote this*. Never the default. |

`MUSE_RECORD=1` saves live replies for replay. They can contain camera crops; inspect them before you commit anything.

## Check your work

```sh
npm run typecheck                                  # every workspace; or one: npx tsc -p apps/server/tsconfig.json
npx vitest run apps/server/src/agent               # run the tests near what you changed
npm test                                           # the whole suite (vitest projects: packages/*, apps/*)
```

Browser checks use `playwright-core` with the installed Google Chrome. Each starts its own FIXTURE server with its own data directory. Run them one at a time; the machine is shared with the live demo.

| Script | Default port | What it checks |
|---|---|---|
| `node scripts/e2e-muse-agent.mjs` | 8798 | The current golden path in the emulator: tag → Control → ask → connector → knobs → MIDI CC → Stop. `LIVE=1` uses the key in `.env`. |
| `node scripts/e2e-reviewer.mjs` | 8801 | The camera/phone page, Buddy, browser instruments. |
| `node scripts/e2e-hands-parity.mjs` | 8796 | The webcam/phone page (`hands.html`) against the Quest flow. |
| `node scripts/e2e-xr-scene.mjs` | 8811 | Muse-written 3D scenes. |
| `PORT=8796 node scripts/e2e-judge.mjs` | 8796 | The older setup-first water flow (legacy harness). |
| `CE_AGENT=0 PORT=8796 node --import tsx apps/server/scripts/wire-e2e.ts` | 8796 | The legacy WIRE path over WebSocket, no browser. It needs `CE_AGENT=0`. |

Set `PORT` to move any of them. A pass in the emulator is not a pass on the headset; say which one you verified.

## Ports

| Port | Owner | Rule |
|---|---|---|
| 8787 | Live server, HTTP | Never use for tests. Never stop it from a test. |
| 8443 | Live server, HTTPS | Never use for tests. |
| 8799 | The Osmo Web Bluetooth page (`CE_OSMO=web`) | Never use. That Chrome tab holds the gimbal's Bluetooth link. |
| 8796 and up | Test servers | Pick a free one. Use `HTTPS_PORT=0` and a fresh `CE_DATA_DIR`. |

The agent's own shell refuses commands that mention 8787, 8443 or 8799.

## Rules that must not break

1. **Every AI model called at runtime is a Meta model.** The models are:
   - **SAM 3.1** (`sam-3.1`): outlines objects.
   - **Muse Spark** (`muse-spark-1.3`): the agent, device identification, Buddy's reactions.
   - **Muse Image** (`muse-image-1.0`): Buddy's stickers and optional panel textures.
   - **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`): spoken asks.
   - **Muse Wonder** (`muse-wonder-1.0`): a guarded fallback in the older `CE_AGENT=0` flow only.
   - **Muse Code**, Meta's coding-agent CLI running `muse-spark-1.3`: the opt-in engine.

   Do not add any other model: no other detector, language model, speech recognizer or voice. OS and browser features are fine (WebXR hand tracking, Web MIDI, Web Bluetooth, Web Serial, macOS speech). If you add one, list it in the README's "OS and browser features" table.
2. **No AI voices.** Speech is macOS `say`, the browser's `speechSynthesis`, the iOS system voice or recorded audio. Sound is wanted in demos: keep the one master volume/mute. `CE_MAC_SILENT=1` and `?mute=1` are for unattended tests only.
3. **No pre-wired interaction.** The app starts in **Annotate**; a pinch only tags an object. **Control** is a deliberate choice. Nothing drives a device until the wearer asks and Muse writes the connector. Do not prefetch (`CE_PREFETCH=1` is for rehearsal only). Do not turn a detected laptop into the visual synth on your own: the visual synth, music synth and Buddy are explicit choices under **More**. Template code is labelled and never the default. A new ask always gets a new program.
4. **Never use the live ports for tests** (8787, 8443, 8799). Use your own port and `CE_DATA_DIR`.
5. **Never commit or print `.env`.** It holds `MODEL_API_KEY` and is in `.gitignore`. Never put a key in client code, a URL or a test fixture.
6. **Secrets stay on the server.** `redactSecrets()` in `apps/server/src/hub.ts` replaces the value of any environment variable whose name contains KEY, TOKEN, SECRET or PASSWORD in everything sent to clients. Connector processes get a reduced environment (`connectorEnv()` in `connector-host.ts`). The agent's file tools refuse `.env`, `.git`, `.certs`, `.ssh` and key files (`workspace-path.ts`), and its shell refuses commands that mention them. Keep all of these when you change the agent.
7. **Gestures first.** Pinch-and-drag is never required: knobs also twist, keys and pads are poked, buttons are tapped. The wrist menu opens only on a deliberate raised left palm.
8. **Honest labels.** LIVE, FIXTURE and TEMPLATE are shown wherever generated code appears. A device acknowledgement means the command was sent and accepted, not that a physical effect was measured.

## How the Muse agent works

1. **The ask.** The headset sends `wire.request {cardId, text, source}`. `WireService` (`apps/server/src/agent/wire.ts`) passes it to the agent. `agentContext()` in `apps/server/src/agent/index.ts` builds what Muse sees: the photo of the selected object, the Mac companion's MIDI outputs, the visual and musical synth manifests, the gimbal's state, whether macOS allows key presses, and `NOTES.md`.
2. **The loop.** `MuseAgent.build()` (`apps/server/src/agent/muse-agent.ts`) calls `muse-spark-1.3` with streamed function calling. Limits: 24 turns, 40 tool calls, 5 minutes (`CE_AGENT_BUDGET_MS`), plus token caps. **Stop Muse** cancels it through an `AbortSignal`.
3. **The tools.**

   | Tool | What it does |
   |---|---|
   | `say` | One progress line in AR; the Mac speaks it with OS speech. |
   | `bash` | zsh in the workspace with a reduced environment. 20 s default, 60 s maximum, output clipped. A deny list blocks system-level and destructive commands, `kill`, the live ports and secret files. Background processes are killed when the shell exits. |
   | `read_file` | The workspace, or this repo (not `.data`, `.env`, `.git` or key files). |
   | `write_file`, `edit_file` | The workspace only. Written files stream into the AR code card. |
   | `open_visuals` | Asks the paired Mac to open the visual synth. |
   | `deploy_connector` | Starts `node <entry>` for the selected card and declares its actions (`set` with min/max, `trigger`, `toggle`; at most 16). Returns start-up output or the crash. |
   | `test_action` | Sends one value to an action, as an AR control would, and returns the connector's log and the device acknowledgements (✓/✗). |
   | `finish` | Returns the result. The server checks it first (step 5). |

4. **The workspace and the connector runtime.** The workspace is `CE_AGENT_WORKSPACE`, or `CE_DATA_DIR/muse-agent` (normally `apps/server/.data/muse-agent`, gitignored). It holds `connectors/<device>/index.mjs`, `NOTES.md` (the agent's memory) and `ce.mjs`. The server rewrites `ce.mjs` before each ask from `CONNECTOR_SDK` in `apps/server/src/agent/connector-host.ts`. A connector imports from it:
   - `onSet(fn)`, `onTrigger(fn)`, `onStop(fn)`: AR controls and hand programs arrive here;
   - `midi.cc / note / program / allNotesOff`: out through the paired Mac companion's Web MIDI;
   - `gimbal.pan / tilt / nudge / recenter / stop`: out through the Osmo bridge, which clamps range and speed;
   - `mac.open / activate / key`: the Mac itself (key presses need Accessibility permission);
   - `log`, `ready`.

   The host and the connector speak JSON lines over stdin/stdout: in `set`, `trigger`, `stop`; out `midi`, `gimbal`, `mac`, `log`, `ready`. `ConnectorHost` runs one process per card. Stop, Stop all or a new ask retires it. A connector is ordinary Node with the Mac user's permissions; this is a trusted local prototype, not a sandbox.
5. **`finish` and its checks.** `finish` takes `title`, `explanation`, and any of:
   - `controls`: up to 6 knobs, sliders, buttons or toggles, each bound to a deployed action;
   - `ui`: a compact instrument design (`InstrumentDesign` in `instrument-ui.ts`): an accent colour, up to 8 widgets (keys, pads, xy-orb, fader, knob, wheel, dimmer-ring, lever, button, toggle) and an optional visualizer. The server compiles it into a `ce.gen3d/1` spec with `packages/gen3d`;
   - `hand_program`: the body of `wire(s, out, mem)`, at most 4 KB;
   - `scene`: the body of `scene(s, draw, mem)`, an XR visualization, at most 8 KB.

   The server rejects bindings to undeclared actions. It validates the hand program (`validateWiring()` in `wire-check.ts`: size, forbidden tokens, syntax, literal action ids) and dry-runs it in an empty `node:vm` context over synthetic hand traces: it must not throw, must average under 2 ms a frame, and must emit at least one valid action. Scenes get the same treatment in `scene-check.ts`. Any issue goes back to Muse, which fixes it and calls `finish` again. An accepted result becomes `wire.ready`.
6. **On the headset.** The hand program runs in a Web Worker made from a blob (`apps/quest/src/wiring/runtime.ts`). Network, storage and worker APIs are removed first. Outputs are limited to the declared actions, clamped to their ranges and rate-limited (30 Hz by default). A watchdog stops a hot loop, and three strikes stop the program. Each output goes to the server as `control.event` `wire:<actionId>`, and on to the connector's `onSet`. Scenes run the same way in `scene-runtime.ts`. Generated code never runs in the companion.
7. **Muse Code (opt-in).** With `CE_AGENT_ENGINE=muse-code`, Meta's `muse` CLI runs the loop with its own shell and file tools (`muse-code-engine.ts`). It reaches `say`, `open_visuals`, `deploy_connector`, `test_action` and `finish` through a loopback MCP server with a per-run bearer token, so those calls run through the same code and checks. With no key, no CLI or in FIXTURE mode, the built-in loop answers instead. `GET /api/agent/connectors` reports which engine ran.
8. **The older path.** `CE_AGENT=0` restores the earlier setup → driver → verify → arm → wire harness. It is kept for compatibility; the default flow does not use it.

## Adding a device safely

First check whether you need code at all. A connector is Node on the Mac, so Muse can already reach HTTP, serial, `child_process` and the network on its own. Add server code only for a transport that Node cannot reach directly, such as browser-only Web MIDI or Web Bluetooth.

1. **The bridge.** Make it pair with the hub like any other device, with its capabilities and ports (see `apps/server/src/devices/osmo/bridge.ts`). Put the safety limits (ranges, speed, rate) in the bridge, not in model-written code.
2. **The runtime.** Add a small helper to `CONNECTOR_SDK` that emits a new JSON line type. Handle it in `ConnectorHost` and route it in `apps/server/src/agent/index.ts`, next to the `midi` and `gimbal` routes.
3. **Tell Muse.** Add the device's state to `AgentContext`/`agentContext()`, and a short contract paragraph to `AGENT_SYSTEM` in `muse-agent.ts`.
4. **FIXTURE parity.** Extend `fixtureScript()` so the no-key path can show it, and add a mock link like `CE_OSMO=mock` for tests.
5. **Protocol.** New message fields go in `packages/protocol/src/` with zod. Mind the size limits.
6. Do **not** add a hand-written mapping that drives the device before the wearer asks.

## Adding an agent tool safely

1. Add a zod schema to `SCHEMAS`, a JSON schema to `AGENT_TOOLS`, and a `case` in the tool switch of `MuseAgent.build()` (all in `muse-agent.ts`).
2. Keep it bounded: a timeout, clipped output (`clip()`), path checks through `resolveAgentPath()`, no secrets in the result, and respect for the `AbortSignal`. Tool results are data for the model, not instructions.
3. If Muse Code should have it, add it to `DEVICE_TOOLS` in `muse-code-engine.ts`. It then runs through the same code.
4. Describe it in `AGENT_SYSTEM`, and add it to `fixtureScript()` if the golden path uses it.
5. Add a small test next to the source (`*.test.ts`, vitest). Keep test suites small.

## Pitfalls

- **Two Quest tabs.** `adb shell am start …` opens a new Quest Browser tab every time. Two tabs fight over the camera ("Could not start video source"). Reload the one tab with `node scripts/quest-reload.mjs` (after `adb forward tcp:9222 localabstract:chrome_devtools_remote`); it refuses while the wearer is in AR.
- **Never `npm run build` into a dist the headset is using.** Use `scripts/deploy-live.sh` or a scratch build with `CE_*_DIST`.
- **Don't reload the headset page, or restart the live server, while the wearer is in AR.** Ask first.
- **A hidden emulator tab stops.** The page sees `visibilityState = hidden` and pauses. Use the headless Playwright scripts.
- **Agent shells have no macOS Bluetooth permission.** `CE_OSMO=ble` scans fail there. Use `CE_OSMO=mock` in tests; the live demo uses `CE_OSMO=web`.
- **Gimbal acknowledgements are not angles.** "Gimbal confirmed the command" means the rotate command was accepted. Don't "fix" a working connector because no angle was measured.
- **The OP-1 shows an input and an output both named "OP-1".** That is normal.
- **Machine load.** The Mac runs the live demo too. Run one browser e2e at a time.
- **Git worktrees.** A symlinked `node_modules` makes `@ce/*` resolve into the main checkout, so you test the wrong code.
- **Don't delete the agent workspace** (`apps/server/.data/muse-agent`). `NOTES.md` holds what Muse learned about the real devices.
- **The emulator is not the headset.** Comfort, tracking, frame time and real devices can only be judged on a Quest. Say "verified in the emulator" or "verified on the Quest".

## Conventions

- Small commits, each with a one-line subject that says what the user gets.
- Plain, honest UI text. Every button visibly does something or says why not.
- Visual changes: small steps, checked with an emulator screenshot. Keep the Horizon look (`apps/quest/src/hud/v2/look.ts`).
- Ask the maintainer before anything irreversible: pushing, deleting data, changing what is public.
