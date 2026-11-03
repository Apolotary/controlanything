# ControlAnything: architecture

How a thing the headset looked at becomes verified, generated controls. Companion to the [README](../README.md); the code is the source of truth (`packages/protocol`, `packages/gen3d`, `apps/server/src/agent`, `apps/server/src/oracle`).

## 1. Two modes, one golden path

**Annotate** (entering AR). The headset shows what it can control:
- on-device YOLOX-Nano boxes appear at once;
- SAM 3.1 outlines and labels come back from the server;
- the wrist palette's *Electronics · Objects · All* switch filters what is shown.

People are never boxed (the COCO person class is dropped in the detector worker; server prompts and labels exclude people). Pinching a box tags it (`tag.add`), and Muse Spark names it without starting setup.

**Control** (a pinch on the Mac's screen, or *Visual synth* on the palette). The headset sends `target.select { virtual: 'visual-synth' }`, and the server binds a card to the paired Mac's renderer. With `CE_DEMO=1` the same selection runs the whole chain:

`LINK → RESEARCH → DRIVE → VERIFY ∥ FORGE → ARM`

The setup ring on the screen shows its progress. The verified, silent target arms itself, and the arc dials appear. Without `CE_DEMO` the card asks for **Set up**, then **Enable controls**. Other devices (the OP-1 Field, the IR light, the Osmo) always take the explicit path: tag, Set up, Enable.

**AI prepares controls; execution is deterministic.**
- A `control.event` becomes a validated driver action, then `exec.command`, then MIDI, IR, BLE or a local op. No model call is involved.
- Dispatch checks the mode, the tag, the executor and the armed state, and applies rate limits.
- **Perform** maps tracked hands onto the same control events: left fist = clutch, right hand height and depth drive the dials.
- **Stop** cancels setup and queued work, disarms the controls and stops automations. It is triggered by both palms out, the palette's Stop, or `X` in the emulator.

**Verification is labelled by what actually confirmed it.** The HUD shows exactly one of four labels:
- *seen ✓*: the headset camera saw the change;
- *renderer ✓*: the camera missed, and the Mac's renderer receipt reports what it applied;
- *acknowledged ✓*: only the executor's acknowledgement;
- *not seen ✗*: failed.

One camera miss on the visual synth hands the rest of that run to the renderer receipts. A transport acknowledgement alone never passes an action that a camera or microphone can observe on a lamp or synth.

**Fallbacks are labelled, never silent.**

| Fallback | Label |
|---|---|
| Recorded model replies | **FIXTURE**, with the model they were recorded from |
| Curated driver template when the live driver call misses its budget | *curated template used (no Meta model wrote this driver)* |
| Forge failure | *template fallback* |
| Prefetched driver/controls | *driver written by … when the Mac appeared* |
| Saved drivers | labelled from the library |

## 2. Components

```
  Quest 3 (WebXR, apps/quest)              Mac: server (apps/server)                          Executors / sensors
  ───────────────────────────              ─────────────────────────────────────────          ───────────────────────────
  YOLOX boxes (local worker, ~15 ms)
  passthrough frame + pose ──scan.frame──▶ SCAN     sam-3.1 outlines; jsQR reads pairing codes
  outlines + pills ◀─────────scan.result─
  pinch the Mac's screen ─target.select──▶ LINK     the paired Mac advertising ce-visual-synth
                                           (CE_DEMO prefetch: DRIVE + FORGE start when the Mac appears)
  setup ring ◀──────agent.step / status─── RESEARCH capability manifest (packages/vsynth) or device chart
                                           DRIVE    muse-spark-1.3 writes the driver; validated vs manifest/allowlist
                                           VERIFY   each action once ─exec.command─▶ Mac companion renderer (Web MIDI-style)
  verify frames ─────────sense.result────▶          camera oracle; else renderer receipt; else ack (labelled)
                                           FORGE    muse-spark-1.3 → ce.hackset/1 → compile → ce.gen3d/1 (∥ VERIFY)
  arc dials + card ◀──────────ui.spec───── ARM      auto for verified silent targets (CE_DEMO), else Enable controls
  dial drag / Perform hands ─control.event▶ CONTROL action → op → exec.command (no model) ──▶ visuals change
  palette Buddy: crop ───/api/buddy──────▶ muse-spark-1.3 reaction · muse-image-1.0 sticker
  palette Use an object: YOLOX-tracked mug/bottle ─control.event─▶ same CONTROL path
  Ask Muse PCM (lab) ───────voice.audio──▶ muse-voice-transcribe-1.0
                                           other executors: OP-1 Field via Web MIDI · Cardputer IR · DJI Osmo (BLE /
                                           Web Bluetooth / mock) · iPhone · DevTerm · Sim room (all of them, virtual)
```

| Component | Path | Role |
|---|---|---|
| Protocol | `packages/protocol` | zod schemas + TS types for every WebSocket message, the Driver, the HackSet, pairing helpers; zod → JSON Schema (`json-schema/*.json`) for the Python and Swift clients and as the Muse `json_schema` response formats. |
| gen3d | `packages/gen3d` | The `ce.gen3d/1` spec (semantic controls + 3D presentation), archetype expansion, validator/repair, patches, theme. |
| Server | `apps/server` | One Node process on the Mac: HTTPS/WSS `:8443` + HTTP/WS `:8787`, the hub at `/ws`, pairing, the Meta model adapters (`src/muse/`), the brain (`src/agent/`), the oracles (`src/oracle/`), SCAN (`src/scan/`), the forge (`src/gen3d/`), voice relay (`src/voice/`), curated device data (`data/devices/`), static hosting of `/quest/`, `/companion/`, `/sim/`. |
| Quest app | `apps/quest` | WebXR app: camera capture with pose history, on-device YOLOX worker, SAM outlines in Annotate, the wrist palette, the setup ring, arc dials on the selected screen and a Horizon-style device card (`@pmndrs/uikit-horizon`). Pointing, poke and pinch through Meta's `@iwsdk/xr-input`. IWER provides desktop emulation; record/replay is available. Lab features (Canvas, Ask Muse, the old menu) stay behind `?lab=1`. |
| Mac companion | `apps/companion` | One status card with a pairing QR (read by the headset camera) and the full-screen visual synth that opens by itself on a pinch; Motion lab at `/companion/tracking/`; owner/approver UI; executors for MIDI (Web MIDI) and the Cardputer (Web Serial JSON lines); the audio oracle (synth USB audio or mic); the agent view (steps with model ids, driver, evidence, links, daemons). One tab executes (Web Locks), others stand by. |
| Cardputer firmware | `firmware/cardputer` | IR node: raw / NEC / AEHA transmit at ≤ 4 frames/s, IR learning through a Grove IR receiver, pairing screen, hack menu on physical keys, serial protocol v1. |
| iPhone | `apps/iphone` | SwiftUI client: pairing, 2D controls and hack lists, handheld scanner / second verification camera, local executor (torch, haptics, screen, say, beep). |
| DevTerm | `apps/devterm` | Python 3.7 stdlib zipapp: pairing (terminal QR, passcode, printed ticket), curses TUI (HACKS, EVIDENCE TAPE, DAEMONS, ROOM), local executor incl. 384-dot thermal receipts. |
| Sim room | `apps/sim` | Virtual laptop (running the visual synth), ceiling light + IR remote and synth; pairs as the Mac's renderer, IR/MIDI executor and camera/audio sensor; renders frames from Blender-rendered light layers with the Quest 3 camera intrinsics; `npm run demo:sim` judge path; take replay. |
| Visual synth | `packages/vsynth` | The silent WebGL2 instrument the Mac shows (Warp, Ripples, Flow/Rings/Prism) and its capability manifest (CCs, programs, effects, rejects) that Muse writes the driver from; renderer receipts report what was applied. |
| Buddy | `apps/quest/src/buddy`, `apps/server/src/buddy` | Desk mascot: quests, Muse Spark reactions to shown objects, Muse Image stickers. |
| Tangible | `apps/quest/src/tangible` | Any tracked mug/bottle/book becomes a controller (YOLOX + One Euro); emits ordinary `control.event`s. |
| DJI Osmo | `apps/server/src/devices/osmo` | DUML over BLE (bleak helper), Web Bluetooth or a mock; safety envelope; `CE_OSMO=ble|web|mock`. |

## 3. Protocol

Every message is one envelope: `{ v: 1, type, id, ts, from, to?, payload }`. The hub stamps `from` with the sender's device id, relays to every other connection (or only to `to`; `to: "server"` stays on the server), answers invalid messages with a `log` error, and drops `control.event`, `scan.frame`, `voice.audio`, `ui.partial`, `device.signal` and `snapshot` for receivers that fall behind (`DROPPABLE_TYPES`).

| Group | Types | Notes |
|---|---|---|
| Session | `hello` / `welcome`, `presence`, `log`, `panic` | `hello` carries the device token; `welcome` the device id, role and model mode. |
| Pairing | `pair.start`, `pair.status`, `pair.approve`, `pair.deny`, `pair.pending`, `pair.approved`, `pair.denied` | Device-code flow: QR + passcode on the unpaired client; approval from a paired quest/mac/iphone, localhost or the server terminal. Codes expire in 5 min, single use. |
| Perception | `scan.frame` (quest → server), `scan.result` (server → HUDs), `target.select`, `target.status` | `scan.frame`: JPEG ≤ 1280 px, pose, camera info, purpose `scan` / `verify` / `pair`. `scan.result`: detections with label, score, box, ≤ 64-point polygon, matched `deviceId`, model id, latency. |
| Modes/tags | `mode.set`, `mode.state`, `tag.add`, `tag.remove`, `tags.state`, `control.setup`, `control.cancel` | Server mode defaults to Annotate; tags are persisted. Setup is explicit and connection-gated. Full tag snapshots refresh on presence changes. |
| Agent | `agent.step`, `device.card`, `link.request`, `link.result`, `driver.spec`, `driver.status` | Every step carries phase, status, model id, effort, latency, source (`live` / `fixture`) and an evidence line. `driver.status` has the per-action verdict (`pending` / `pass` / `fail` / `untested`). |
| Execution | `exec.command` (server → executor), `exec.ack` (executor → server) | Op kinds: `midi` (cc, note, pc, identity request, panic), `ir` (raw µs timings or NEC/AEHA bytes), `local` (volume, music, say, torch, haptic, print, screen, beep). The ack says the bytes left; never that the device reacted. |
| Sensing | `sense.request` (server → sensor), `sense.result` | Kinds: `frame` (a verify frame as `scan.frame`), `audio-features` (RMS, centroid, bands), `ir-capture` (raw timings from a receiver). |
| Verdicts | `verify.result` | An `Evidence` record: sent op, expected effect, observed metric with before/after/delta/threshold, pass, attempt, note. |
| Consent | `arm.request`, `arm.confirm`, `arm.result` | One tap before the first drive; `hold: true` for irreversible drivers; requests expire (120 s). |
| Controls | `ui.spec`, `ui.partial`, `control.event`, `daemon.status`, `device.signal` | `ui.spec` = `{ specId, cardId, driverId, rev, gen3d, hackset, check }`; `ui.partial` streams items as the model finishes them; `control.event` = `{ widgetId, value, phase: start | move | end, ts, specId }`. |
| Voice | `voice.audio` (PCM16 chunks), `voice.text` (transcript + addressed assistant state), `voice.confirm`, `voice.cancel` | Typed text takes the same route. Setup requests use the existing Quest setup flow; gesture proposals require explicit acceptance. |
| Object games | `canvas.request`, `canvas.get`, `canvas.cancel`, `canvas.restore`, `canvas.action`, `canvas.state` | Muse authors bounded choice-game data. The server owns revisions and play state; Quest and Mac share previews, scores and explicit Play. No device execution. |

HTTP views: `GET /api/agent/targets[/:cardId]`, `/api/agent/scan/latest`, `/api/agent/steps`, `/api/agent/exec`, `/api/agent/profiles`, `/api/muse/calls`; `POST /api/agent/select`, `/api/agent/arm`, `/api/agent/panic`; pairing under `/api/pair/*`; `GET /api/health`.

### Driver (declarative, generated, validated)

```ts
Driver = { driverId, cardId, transport: 'midi' | 'ir' | 'local', executor: { deviceId, port? },
  provenance: [{ source: 'chart' | 'learned' | 'irdb' | 'web_search' | 'manual', ref }],
  actions: [{ actionId, label, kind: 'set' | 'trigger' | 'toggle', range?: { min, max, step? },
    encode: MidiOp | IrOp | LocalOp | StepOp,          // '$value' placeholder for 'set'
    expect?: { sense: 'camera' | 'audio' | 'ack' | 'none',
               effect: 'on' | 'off' | 'brighter' | 'dimmer' | 'warmer' | 'cooler' | 'louder' | 'quieter' | 'tone-up' | 'tone-down' | 'any' },
    inverseActionId? }] }
```

IR codes are named by reference (`lib:<brand>/ch<n>/<key>` or `learned:<id>`); the server fills bytes and timings, so a model can never invent a code. A `step` encode turns brighter/dimmer triggers into a 0–100 "set" action for dimmer rings. Validation before anything executes: schema; allowlists (CC numbers from the chart, IR codes from the library or the learned captures, declared local ops; no SysEx writes); ranges; rate caps. Rate limits (`RATE_LIMITS`): MIDI ≤ 200 msg/s per executor, IR ≤ 4 frames/s, visible-light changes ≤ 3 Hz, control budget 50 ms on the LAN. Panic = all notes off, pending IR dropped, daemons stopped.

## 4. The agent state machine

One `Target` per device (`TargetState`, `packages/protocol/src/primitives.ts`). Tagging stops at identification. The setup chain below begins after an explicit `control.setup`, or, with `CE_DEMO=1`, after the pinch that selects the Mac's visual synth. With `CE_DEMO=1`, a newly available Mac renderer also starts a background **prefetch** of that driver and its controls, used once and re-validated on the pinch. Otherwise a companion appearing only updates connection status. Pipeline transitions use `target.status` and `agent.step`.

```
ANNOTATE: scanned → identifying → identified (tag persisted; no setup)
CONTROL:  setup request (or the CE_DEMO pinch on the Mac) + bridge → linking → linked → researching → driving
          → verifying → verified → forging → forged → arming → armed ⇄ controlling
no bridge → connection hint; connect it and request setup again
setup failure/cancellation → failed
Stop → cancel pending work, disarm controls, stop automations
```

| Step (`src/agent/`) | What happens | Model |
|---|---|---|
| SCAN `scan.ts` | SAM prompts in parallel per frame (default `electronic device`, `ceiling light`, `synthesizer`; `CE_SCAN_PROMPTS` overrides; a filter refuses person/face/hand prompts and labels). Masks → ≤ 64-point outlines (Douglas–Peucker), detections deduplicated across prompts by IoU and matched to known targets. A pairing QR in view approves that pairing. | `sam-3.1` |
| IDENTIFY `identify.ts` | Crop (detail high) + whole frame (detail low) → `DeviceCard` via `json_schema`: name, maker/model (`unknown` unless legible text supports it), category, protocols, companion need, evidence, follow-ups. | `muse-spark-1.3`, effort low |
| LINK `link.ts`, `executors.ts` | Executor by capability (midi / ir / local) from presence. USB: port name against the chart's hint, then the MIDI identity request (`F0 7E 7F 06 01 F7`) against the maker Spark read → `confirmed` / `consistent` / `mismatch` ("wrong device, refused") / `unknown` (a generic non-commercial id is inconclusive, not a mismatch). No executor → `link.request` with suggested clients, state `needs-companion`. | none |
| LEARN `learn.ts` | For unknown remotes: `sense.request ir-capture` per button (全灯, 消灯, 明るく, 暗く, 常夜灯, 暖色, 白色), one press each; the capture becomes a `LearnedCode` with the button as a *hypothesis* label; the learn window closes 700 ms after the first captured press. Stored next to the curated data as `<device>.learned.json`. | none |
| RESEARCH `research.ts` | Curated charts, explicitly reviewed per-instrument MIDI charts, the IR library and learned codes form the brief. Reviewed charts bind to exact card/maker/model and carry a manual citation, channel and CC ranges; importing one stores knowledge without commands or arming. Sourced web prose is cached for seven days but cannot create an executable CC allowlist. Explicit setup rerun refreshes research. See [MIDI charts](MIDI-CHARTS.md). | `muse-spark-1.3` + `web_search` (fallback) |
| DRIVE `drive.ts` | `DriverDraft` via `json_schema` from the brief; validated; issues fed back. For the visual synth the brief is its **capability manifest** (`packages/vsynth/src/manifest.ts`: CCs, programs, effects, rejects): Muse chooses the actions and the server validates them against the manifest (ids from the wire message, CC/program allowlist, ranges). The live call has a time budget; past it, or on an invalid draft, the curated template stands in and the step says so (*no Meta model wrote this driver*). Other devices: two attempts, Spark low → Spark medium repair; a matching curated template may be used with its source disclosed. | `muse-spark-1.3` |
| VERIFY `verify.ts` | Each action once, for real. Lamps go visible-first (off, on, dimmer, brighter, colour, night last; the lamp is relit before brightness probes). The camera takes a verify frame before and after; SAM finds the outline again on the before frame. IR lamps get settle time (~3 s fade). Audio: a note is held while the CC sweeps, and feature windows are compared before and after. The **visual synth** asks the camera first. After one camera miss, the rest of the run uses the Mac renderer's receipt (*verified by renderer: …*), and then the executor's ack. Each result is labelled *seen ✓* / *renderer ✓* / *acknowledged ✓* / *not seen ✗*. Every miss is a `verify.result` with `pass: false`. | `sam-3.1` (outline only) |
| FORGE `../gen3d/forge.ts` | Hack set (`ce.hackset/1`) bound to verified `actionId`s via `json_schema`, streamed; deterministic checks (schema → bindings → geometry → safety); ≤ 2 repairs at medium effort; compiled to `ce.gen3d/1`. Controls bound to unverified actions are `armed: false`. | `muse-spark-1.3`, effort low |
| SKIN `../gen3d/skin.ts` | Optional device-inspired panel texture, generated alongside controls and published without delaying arming; `GEN3D_SKIN=0` disables it. | `muse-image-1.0` |
| ARM `arm.ts` | Before the generated controls go live, `arm.request` goes to every client. An approver (a paired quest / mac / iphone, or localhost) answers `arm.confirm`. Irreversible drivers use `hold: true`, and requests expire after 120 s. With `CE_DEMO=1`, a verified, reversible, silent target (the visual synth) arms itself, and the step reads *auto-armed after verification (CE_DEMO=1)*. | none |
| CONTROL `control.ts`, `dispatch.ts` | `control.event` → hack → action → resolved op → `exec.command` with no await before the send; per-hack and per-executor token buckets; step planning for IR dimmers (≥ 334 ms between light changes); latest-wins coalescing under the limits; undo (inverse action or restore); panic. | none |

Hack lifecycle on every surface (`HackStatus`): `ready` · `locked` (unverified) · `queued` · `uploading` (GEN · CHECK · SEND · SEEN) · `verified` · `failed`. Driver lifecycle (`DriverPhase`): `drafting` · `validating` · `verifying` · `verified` · `armed` · `disarmed` · `failed`.

## 5. Oracles (deterministic, no model)

| Oracle | Input | Metric | Default thresholds (`src/oracle/`) |
|---|---|---|---|
| **Camera** `camera.ts` | Two frames at (nearly) the same pose, the SAM polygon | **mask vs ring:** mean luma inside the polygon over a ring around it (ring = the outline's box grown by 35 %, minus the box grown by 8 %; `ringFactor 0.35`); cancels auto-exposure. **absolute:** mean luma of mask + ring, only when exposure is locked (sim, replay, AE off); sees dimmer *steps* of a lamp that lights its own ring. **R/B ratio** in the mask for colour temperature. | brighter/dimmer: ratio Δ ≥ 12 % (`luma: 0.12`) · step at fixed exposure: abs Δ ≥ 4 % (`abs: 0.04`) · warmer/cooler: R/B Δ ≥ 8 % (`rb: 0.08`) · on/off: ratio Δ ≥ 40 % (`onOff: 0.4`) or abs Δ ≥ 50 % (`onOffAbs: 0.5`). Two consecutive confirmations. < 200 ms. |
| **Audio** `audio.ts` | Feature windows before/after (the synth's USB audio into the Mac, or the mic): RMS dBFS, spectral centroid Hz, octave bands | louder/quieter: RMS Δ; tone-up/tone-down: centroid moved in octaves; `silent` when both windows are under the floor | `rmsDb: 3` dB · `centroidOctaves: 0.2` · `silenceDb: −60`. Negative control: a CC outside the chart must read "no change". |
| **Wire** `link.ts` | USB port descriptor, MIDI identity reply | maker/model match with the camera's DeviceCard | `confirmed` (both), `consistent` (name only), `mismatch` → refused |
| **Renderer receipt** | the visual synth's own report of the parameters it applied (frame, values) | what the Mac actually rendered | a pass labelled *renderer ✓*, never *seen* |
| **Ack** | `exec.ack` | the executor sent the bytes | a pass only for silent virtual targets, labelled *acknowledged ✓*; never a pass on its own for a lamp or synth the camera or mic can observe |

Every verdict is an `Evidence` record (`{ sent, expected, observed: { sense, metric, before, after, delta, threshold }, pass, attempt, note }`) and is shown on the HUD as a sentence: `sent dimmer → light got 38 % darker ✓` / `sent 0x2A → no change ✗`.

## 6. Generated controls: two layers (`packages/gen3d`, `ce.gen3d/1`)

**(a) Semantic control layer** (every client renders it: 3D on the Quest, 2D on the iPhone, a numbered list on the DevTerm, keys on the Cardputer):

```ts
Control { id, kind: continuous | stepped | toggle | trigger | xy, label (≤ 16), range { min, max, step? }, yRange?, unit?,
          default?, stepLabels?, accent?, minLabel?, maxLabel?, bipolar?, curve?, hint?, binding: Binding, yBinding?, armed? }
Binding { action /* driver actionId, or midi.cc | midi.note | ir.send | sim.* */, driverId?, channel?, cc?, note?, args? }
```

A control bound to an unverified action has `armed: false`; the current main Quest card omits unavailable actions and blocks their events. Lower-level gen3d renderers can represent them as disabled controls. Events: `ControlEvent { controlId, value, phase: start | move | end, ts, specId }`.

**(b) 3D presentation layer** (the Quest renders it): `Part { kind: group | primitive | archetype | text | path, shape, dims, archetype, params, controlId, text, path, transform, material, visibleWhen, parentId }`. Primitives: box, cylinder, sphere, torus, capsule, cone, ring, plane, lathe, extrude. Materials: `solid | holo | wire | glass | glitch` with glow, fresnel, scanlines, flicker ≤ 3 Hz. Behaviours (`rotate | slide | press | toggle | pull | xy | grab`) and feedback (`glow | arc-fill | readout | tick | particles | beam-pulse | scale-pop | color-shift | glitch`) target parts by role. Anchors: `device | floating | surface | hand | world` (the ceiling light's controls float at 0.9 m, below the horizon; desk devices dock beside the device).

The schema and lower-level gen3d renderer are broader than the current main Quest card. That card keeps one continuous control and up to three buttons in a stable panel, honoring slider, knob and lever archetypes with horizontal, angular and vertical input respectively. It does not promise arbitrary meshes, ring layouts or a fully generated XY shape. A shape-edit acceptance check must show the rendered before/after control and use it, not merely compare JSON.

**Archetypes** (one part expands to parts + behaviours + feedback, as pure data): controls `knob`, `fader`, `lever`, `button`, `toggle`, `dimmer-ring`, `pull-cord`, `xy-orb`, `pads`, `keys`, `wheel`; HUD `outline`, `tag`, `brackets`, `twin`, `sweep-plane`, `reticle`, `ping-line`, `link-matrix`, `oracle-strip`, `hack-list`, `queue-strip`, `upload-bar`, `daemon-link`, `deck`, `model-chips`, `worklog`, `ir-waveform-card`, `remote-chips`, `handle`.

**Limits** (`LIMITS`, enforced by `validateSpec` / `repairSpec`): controls ≤ 24 · parts ≤ 160 (≤ 600 expanded) · behaviours/feedback ≤ 64 · tree depth ≤ 8 · ~80 k triangles · extent ≤ 1.2 m · interactive targets ≥ 44 mm · text cap height ≥ 6 mm · flash ≤ 3 Hz.

**Generation** (`apps/server/src/gen3d/`, measured in `research` on Nov 2): the model writes the **semantic hack set** (`ce.hackset/1`: verb-first hacks ≤ 14 chars, params, `control.archetype`, commands bound to driver actions, oracle expectation, `inverse`, `max_rate_hz ≤ 3`); the server checks it (banned vocabulary, lengths, command vocabulary, ranges, dangling refs, rate caps; ≤ 2 repairs with the issues fed back) and **compiles it deterministically** to `ce.gen3d/1` (one archetype part per control, a hack list, a tag, model chips, deterministic layout with ≥ 10 cm between controls). Daemons are generated in a second, small call over *verified* hacks only; "no strobe" / "calm" clamp to ≤ 1 Hz. Edits ("make the resonance control a big red lever") are model-written collections patches applied by id, with a proof that untouched items are byte-identical, and an undo/redo stack per spec. Streaming: `json_schema` output is scanned for completed top-level items, so the headset assembles controls while the model is still writing (`ui.partial`).

## 7. Recordings, fixtures and replay

| Layer | What is recorded | How it replays |
|---|---|---|
| Model calls | `MUSE_RECORD=1` in live mode writes `apps/server/fixtures/recorded/<key>.json`: model id, `recordedAt`, latency, token usage, the answer text. Never the prompt, the frame or the key. | Fixture mode (no `MODEL_API_KEY`, or `MODEL_MODE=fixture`) replays them; a recorded answer wins over the canned FIXTURE for the same key; results say `source: "fixture"` with `recordedFrom: <model id>`, and every HUD labels them `FIXTURE`. SAM fixtures: exact recorded frame > sim-room ground truth by pose > same-size recording > canned scene. |
| Headset takes | Opt-in `Recorder` in the Quest app: `session.jsonl` (up to 30 Hz head/25-joint hand poses, tracking gaps and reference-space boundaries, messages and inputs), `frames/*.jpg`, and video-only passthrough `video.webm`/`video.mp4` when supported. A bounded take ZIP preserves source and approximate clock alignment. | `/companion/tracking/` reviews video and spatial poses on one timeline and exports validated telemetry plus allowlisted interaction metadata; it never executes recorded commands. Existing `playback` and `pipeline` replay modes remain available; the sim player re-sends recorded messages and compares answers. See [tracking review](TRACKING-REVIEW.md). |
| Agent runs | `GET /api/agent/steps` (work log with model ids), `/api/agent/exec` (every op and ack), `/api/agent/targets` (state, card, link, driver, verification, evidence), `/api/muse/calls` (every model call). | Tests replay the committed gen3d recordings through the current checks and require them to reach armed controls when the evidence passes. |
| Learned codes | `apps/server/data/devices/<device>.learned.json`: capture timings, the hypothesis, the label the camera assigned, the evidence. | The sim lamp obeys exactly those codes once they exist, so the real remote's codes drive the virtual room too. |

`npm test` covers the workspace suites (protocol, gen3d, oracles, codecs, the agent end to end over the real hub in sim mode, DevTerm contract tests against the JSON Schemas, Cardputer host tests separately). The muted Chrome checks are `npm run e2e:judge` (golden path, `CE_DEMO=1`: pinch → ring → armed dials → dial drag → Perform → both-palms Stop) and `npm run e2e:vsynth` (explicit Set up → Enable, with a pixel check on the sim laptop). Both take `PORT=`. See the [judge path](../README.md#judge-path-no-hardware).

## 8. Measurements

**Golden path** (independent verification pass, Nov 4, desktop emulator, `CE_DEMO=1`):

| Mode | Pinch → armed |
|---|---|
| Fixture | 1.3 s |
| Live, cold | 29.0 s: Spark identify 8.2 s, driver 7.1 s, forge 7.8 s plus one forge repair 13.2 s. An earlier probe took 41.9 s. |
| Live, with the driver/controls prefetch | 1.2 s, measured by the builder after the verification pass. |

Other numbers from that pass:
- 24 SAM 3.1 calls in one live run.
- YOLOX-Nano at 12–13 fps, 15–19 ms per inference on WebGPU.
- QR pairing by looking: 1.6 s after Enter AR.
- Emulator draw calls 32–80 per state.

No headset frame rate has been measured since the redesign.

**Historical component measurements** (Nov 2, 2026, live Meta Model API):


These are separate component runs, mostly against rendered/simulated inputs. They are not a measured total setup latency, a continuous live-headset demonstration, or physical hardware acceptance. Model/output validity is scoped to the cited runs rather than a guarantee for future requests.

| What | Number | Where measured |
|---|---|---|
| SAM 3.1, one prompt, one 1280×960 frame | 1.7–3.9 s (0.6–3.8 s across sizes); prompts in parallel ≈ 3.5 s wall for 4–9 | sim-room frames and a test scene |
| SAM 3.1 on the unlit sim lamp, prompt `ceiling light` | IoU 0.98 with the render's exact outline, confidence 0.76 | `apps/sim/scripts/sam-check.ts` |
| Spark IDENTIFY (DeviceCard, 2 images, low effort) | ≈ 5 s (recorded: 4.3 s) | `fixtures/recorded/device_card_*.json` |
| Spark DRIVE (declarative driver, json_schema) | 7.8 s | sim light run |
| IR learning (virtual remote) | 7 / 7 buttons captured and decoded | sim room |
| Camera verification | 8 / 8 actions passed: off −57 %, on +196 %, dimmer/brighter steps ±12–14 % (mask vs ring); every ignored code reported as no change | sim room, `oracle-check.ts` covers all 34 lamp transitions |
| Audio verification (sim synth, OP-1 Field CC map) | CC 46 sweep: spectral centroid ×2.5 → `tone-up ✓`; CC 20 (not in the chart): no change; honest misses reported | sim room |
| FORGE (hack set + controls, Spark low, streamed) | 13–19 s in the loop; benchmark p50 11.5 s, first item at 8.9 s, 25/25 first-shot valid; $0.015/run | `apps/server/scripts/gen3d-bench.ts` |
| Edit ("big red lever") | 4.5–12 s; untouched items byte-identical | same |
| Muse Wonder as driver writer | 19.9 s at low effort; 2 of 7 json runs looped on whitespace (hence the guard) | codegen benchmark |
| Voice (Muse Voice Transcribe, batch WAV) | 2.6 s for a 2.45 s utterance, exact transcript | probe |
| Control loop | server side < 1 ms per `control.event`; budget 50 ms on the LAN | `agent/control.ts` |

The real headset session observed Ask Muse speech and OP-1 MIDI port discovery, but did not demonstrate successful physical instrument control. The instrument is an OP-1 Field; its firmware and physical effects remain unverified. Cardputer/IR effects and the revised real-headset interaction flow also need acceptance. Use [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md) to record the next run and retain its actual model/source labels, timing and effect evidence.

## Object canvas (lab)

`packages/protocol/src/canvas.ts` validates the game format (1–6 rounds, 2–3 choices, bounded text and scores, unique IDs) and contains its deterministic reducer. `apps/server/src/canvas/` generates drafts through Muse Spark and maintains atomic local `canvas-history.json` beside the device library: 64 objects, eight revisions each. Restore creates a new revision; generation and restore always return to preview. Starting or restarting is an explicit user action. Play state is shared in memory and returns to preview after server restart.

Canvas is independent of Forge, drivers and physical executors. A tagged object in Control mode may have no control connection. Only authorized owners/local clients can mutate the shared game; server-only `canvas.state` carries the authoritative result. Request IDs deduplicate actions, base revisions reject stale edits, and exact round IDs plus reducer phases prevent double scoring. Generation is scoped to the requesting client and object and is cancelled on selection/mode changes, disconnect or removal. Forget removes its history.

Quest's selected card provides Make a game, preview, Play, choices, feedback and restore. Ask Muse routes game creation/edits before the hardware offline gate; game undo cannot invoke physical undo. The companion places Object games below setup and Devices, with an explicit Open Canvas entry and contextual opening for newly started games; Hide Canvas persists through subsequent status updates. It renders the same document with a prompt box and revision restore. Both render plain data without scripts, audio or extra animation loops. Closed XR panels stay closed on Mac updates and reload current state when reopened. Ordinary-object recognition includes books in All and never invents unread content or a hardware connection.

## Interaction retrieval

The saved library remains the source of truth for completed device interfaces. `agent/interaction-references.ts` selects up to three bounded descriptive examples from active, enabled, visible versions, ranked by maker/model, category and compatible action labels. Forge generation and editing receive these as untrusted reference data; examples contain no executor or action IDs and never transfer verification. Request/current controls take priority, and the ordinary schema and binding checks still run.

`knowledge/interactions.ts` stores only gesture mappings accepted through Ask Muse's Apply flow. Exact reuse requires the same card, normalized request, complete hardware contract and live/fixture source, plus current verification. A fresh proposal is issued without planning/mapping calls only when it preserves current bindings; confirmation and Perform remain separate. Related compatible memories ground new mapping requests. Entries persist atomically (128 maximum), tolerate corrupt files, and are purged by Forget. Restoring an existing library device still restores its UI and gesture map without regeneration.

`research/cache.ts` wraps web search with exact-question, endpoint/model/instructions/effort isolation, seven-day expiry and explicit refresh. Only nonempty live results with HTTP(S) citations qualify. Fixture responses, failed calls and uncited answers are never cached. Cached results preserve original model, citations and research timestamp; physical verification is always independent. Both stores live beside `library.json`; tests can keep them in memory.


## Lab features

The following stay in the code, reachable with `?lab=1` (palette → *More (lab)*), and are off the golden path:
- Muse Canvas and object games;
- Ask Muse voice requests and gesture mappings;
- manual area identification;
- the old menu.

`npm run e2e:projects` and `npm run e2e:chords` exercise Canvas through its HUD event.
