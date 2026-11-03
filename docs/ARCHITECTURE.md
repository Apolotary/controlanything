# ControlAnything: architecture

How a thing the headset looked at becomes verified, generated controls. Companion to the [README](../README.md); the code is the source of truth (`packages/protocol`, `packages/gen3d`, `apps/server/src/agent`, `apps/server/src/oracle`).

## 1. Principle

**Annotate first; Control only by request.** Entering AR selects Annotate: local YOLOX-Nano preview boxes plus background SAM device segmentation, All / Electronics filters, a default 3 m estimated range and a three-candidate budget. The COCO people class is dropped in the detector worker; server scan prompts and labels also exclude people. Underlying light/IR support remains available, although there is no separate Lights filter. Pinching sends `tag.add`; Muse Spark identifies the crop and the server persists the tag without starting setup. Estimated positions do not establish scene depth or wall occlusion.

Switching to Control stops annotation scanning and hides untagged detections. `tags.state` reports `ready` (verified, armed, executor online), `setup` (reachable but needs setup) or `offline` (with a connection hint). Only **Set up control** (`control.setup`) starts LINK → LEARN/RESEARCH → DRIVE → VERIFY → FORGE → ARM. It requires Control mode, a tag and an available bridge, including a MIDI port for a synth. The setup request authorizes physical verification; **Enable controls** is a separate confirmation. `target.select` in Annotate only tags/identifies; selecting in Control reopens existing controls, never starts setup.

**AI prepares controls; driver execution is deterministic.** `control.event` → validated driver action → `exec.command` → MIDI / IR / local operation contains no model call. Voice transcription, research and control edits still call models. Dispatch checks the mode, tag, executor and setup/armed state; a successful transport acknowledgement alone cannot prove a visible or audible effect. Stop cancels setup and queued work, disarms controls and stops automations. Returning to Annotate cancels unfinished setup and stops automations while preserving completed arming for a later return to Control.

## 2. Components

```
  Quest 3 (WebXR, apps/quest)           Mac: server (apps/server)                         Executors / sensors
  ───────────────────────────           ──────────────────────────────────────────         ────────────────────────────
  passthrough frame + pose ─scan.frame─▶ SCAN   sam-3.1 (parallel device prompts)
  YOLOX boxes (local worker)
  SAM outlines ◀──────────scan.result─ + QR decode (pairing by sight)
  pinch to tag ─────────────tag.add────▶ IDENTIFY muse-spark-1.3 → persisted tag
  switch mode ─────────────mode.set───▶ CONTROL mode (no setup yet)
  Set up control ───────control.setup─▶ check tag + bridge + explicit request
  "needs a companion" ◀───link.request── LINK   executor by capability; USB name + MIDI identity cross-check
                                        LEARN  one press per remote button ──sense.request(ir-capture)──▶ Cardputer IR receiver / sim remote
                                        RESEARCH curated charts + IR library (data/devices), web_search fallback
                                        DRIVE  muse-spark-1.3 (low → medium repair) → matched template / missing-data result
                                               validate: allowlists, ranges, rate caps
                                        VERIFY each action once ──exec.command──▶ Mac companion ─Web MIDI─▶ OP-1 Field
  before/after frames ──sense.result──▶        camera oracle (mask vs ring, R/B)      Mac companion ─Web Serial─▶ Cardputer ─IR─▶ ceiling light
  (companion / synth audio) ─sense.result─▶    audio oracle (RMS, centroid)            Mac local (osascript: volume, music, say)
  evidence strip ◀───────verify.result──                                               iPhone (torch, haptics, screen, say)
  hacks + 3D controls ◀────────ui.spec── FORGE  muse-spark-1.3 → ce.hackset/1 → compile → ce.gen3d/1   DevTerm (print, beep, say, screen)
  Enable controls ◀─arm.request / arm.confirm─▶ ARM   human confirmation (hold for irreversible)         Sim room (all of the above, virtual)
  pinch / twist ────────control.event──▶ CONTROL hack → action → op → exec.command (no model)  ──▶ device reacts
  Ask Muse PCM ──────────voice.audio──▶ muse-voice-transcribe-1.0 → voice.text → selected-device Muse planner
  voice.confirm ─────────────────────▶ validate proposal → Forge gesture revision → ui.spec
```

| Component | Path | Role |
|---|---|---|
| Protocol | `packages/protocol` | zod schemas + TS types for every WebSocket message, the Driver, the HackSet, pairing helpers; zod → JSON Schema (`json-schema/*.json`) for the Python and Swift clients and as the Muse `json_schema` response formats. |
| gen3d | `packages/gen3d` | The `ce.gen3d/1` spec (semantic controls + 3D presentation), archetype expansion, validator/repair, patches, theme. |
| Server | `apps/server` | One Node process on the Mac: HTTPS/WSS `:8443` + HTTP/WS `:8787`, the hub at `/ws`, pairing, the Meta model adapters (`src/muse/`), the brain (`src/agent/`), the oracles (`src/oracle/`), SCAN (`src/scan/`), the forge (`src/gen3d/`), voice relay (`src/voice/`), curated device data (`data/devices/`), static hosting of `/quest/`, `/companion/`, `/sim/`. |
| Quest app | `apps/quest` | WebXR app: camera capture with pose history, on-device YOLOX worker, SAM scans in Annotate, a mode/filter bar, tagged outlines and one selected control card. Inter SDF text via troika-three-text; poke and ray/pinch input; stable open panels with explicit left-palm/controller recall. Logs and evidence are in Details. IWER provides desktop emulation; record/replay is available. |
| Mac workbench | `apps/companion` | Owner/approver UI; executors for MIDI (Web MIDI) and the Cardputer (Web Serial JSON lines); the audio oracle (synth USB audio or mic); the agent view (steps with model ids, driver, evidence, links, daemons). One tab executes (Web Locks), others stand by. |
| Cardputer firmware | `firmware/cardputer` | IR node: raw / NEC / AEHA transmit at ≤ 4 frames/s, IR learning through a Grove IR receiver, pairing screen, hack menu on physical keys, serial protocol v1. |
| iPhone | `apps/iphone` | SwiftUI client: pairing, 2D controls and hack lists, handheld scanner / second verification camera, local executor (torch, haptics, screen, say, beep). |
| DevTerm | `apps/devterm` | Python 3.7 stdlib zipapp: pairing (terminal QR, passcode, printed ticket), curses TUI (HACKS, EVIDENCE TAPE, DAEMONS, ROOM), local executor incl. 384-dot thermal receipts. |
| Sim room | `apps/sim` | Virtual ceiling light + IR remote + synth; pairs as IR/MIDI executor and camera/audio sensor; renders frames from Blender-rendered light layers with the Quest 3 camera intrinsics; `npm run demo:sim` judge path; take replay. |

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

One `Target` per device (`TargetState`, `packages/protocol/src/primitives.ts`). Tagging stops at identification. The setup chain below begins only after an explicit `control.setup`; a newly available companion updates connection status and does not start setup automatically. Pipeline transitions use `target.status` and `agent.step`.

```
ANNOTATE: scanned → identifying → identified (tag persisted; no setup)
CONTROL:  explicit setup + tag + bridge → linking → linked → researching → driving
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
| DRIVE `drive.ts` | `DriverDraft` via `json_schema` from the brief; validated; issues fed back. Production setup permits two attempts: Spark low → Spark medium repair. A matching curated template may be used with its source disclosed; unavailable device knowledge must remain unavailable. The writer module also contains a third Wonder attempt for callers/benchmarks that allow it, but the production setup's two-attempt cap never reaches it. | `muse-spark-1.3` in production; Wonder writer available separately |
| VERIFY `verify.ts` | Each action once, for real, visible-first (off, on, dimmer, brighter, colour, night last; the lamp is relit before brightness probes). Camera: a verify frame before and after (SAM re-finds the outline on the before frame), settle time for IR lamps (~3 s fade). Audio: a note held while sweeping the CC; feature windows before/after. Two consecutive confirmations make a pass. IR library candidates are cycled (bounded); every miss is a `verify.result` with `pass: false`. | `sam-3.1` (outline only) |
| FORGE `../gen3d/forge.ts` | Hack set (`ce.hackset/1`) bound to verified `actionId`s via `json_schema`, streamed; deterministic checks (schema → bindings → geometry → safety); ≤ 2 repairs at medium effort; compiled to `ce.gen3d/1`. Controls bound to unverified actions are `armed: false`. | `muse-spark-1.3`, effort low |
| SKIN `../gen3d/skin.ts` | Optional device-inspired panel texture, generated alongside controls and published without delaying arming; `GEN3D_SKIN=0` disables it. | `muse-image-1.0` |
| ARM `arm.ts` | Before the generated controls go live: `arm.request` to every client; an approver (paired quest / mac / iphone, or localhost) answers `arm.confirm`; `hold: true` for irreversible drivers; 120 s expiry. The explicit Set up control request is the go-ahead for VERIFY's test drives; tagging alone is not. | none |
| CONTROL `control.ts`, `dispatch.ts` | `control.event` → hack → action → resolved op → `exec.command` with no await before the send; per-hack and per-executor token buckets; step planning for IR dimmers (≥ 334 ms between light changes); latest-wins coalescing under the limits; undo (inverse action or restore); panic. | none |

Hack lifecycle on every surface (`HackStatus`): `ready` · `locked` (unverified) · `queued` · `uploading` (GEN · CHECK · SEND · SEEN) · `verified` · `failed`. Driver lifecycle (`DriverPhase`): `drafting` · `validating` · `verifying` · `verified` · `armed` · `disarmed` · `failed`.

## 5. Oracles (deterministic, no model)

| Oracle | Input | Metric | Default thresholds (`src/oracle/`) |
|---|---|---|---|
| **Camera** `camera.ts` | Two frames at (nearly) the same pose, the SAM polygon | **mask vs ring:** mean luma inside the polygon over a ring around it (ring = the outline's box grown by 35 %, minus the box grown by 8 %; `ringFactor 0.35`); cancels auto-exposure. **absolute:** mean luma of mask + ring, only when exposure is locked (sim, replay, AE off); sees dimmer *steps* of a lamp that lights its own ring. **R/B ratio** in the mask for colour temperature. | brighter/dimmer: ratio Δ ≥ 12 % (`luma: 0.12`) · step at fixed exposure: abs Δ ≥ 4 % (`abs: 0.04`) · warmer/cooler: R/B Δ ≥ 8 % (`rb: 0.08`) · on/off: ratio Δ ≥ 40 % (`onOff: 0.4`) or abs Δ ≥ 50 % (`onOffAbs: 0.5`). Two consecutive confirmations. < 200 ms. |
| **Audio** `audio.ts` | Feature windows before/after (the synth's USB audio into the Mac, or the mic): RMS dBFS, spectral centroid Hz, octave bands | louder/quieter: RMS Δ; tone-up/tone-down: centroid moved in octaves; `silent` when both windows are under the floor | `rmsDb: 3` dB · `centroidOctaves: 0.2` · `silenceDb: −60`. Negative control: a CC outside the chart must read "no change". |
| **Wire** `link.ts` | USB port descriptor, MIDI identity reply | maker/model match with the camera's DeviceCard | `confirmed` (both), `consistent` (name only), `mismatch` → refused |
| **Ack** | `exec.ack` | the executor sent the bytes | never a pass on its own for anything the camera or mic can observe |

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

`npm test` covers the workspace suites (protocol, gen3d, oracles, codecs, the agent end to end over the real hub in sim mode, DevTerm contract tests against the JSON Schemas, Cardputer host tests separately). The muted Chrome checks `npm run e2e:judge` (12 phases) and `npm run e2e:flows` (18 phases) exercise the two-mode desktop flow; see the [judge path](../README.md#judge-path-no-hardware).

## 8. Historical component measurements (Nov 2, 2026, live Meta Model API)

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

The real headset session observed Ask Muse speech and OP-1 MIDI port discovery, but did not demonstrate successful physical instrument control. The user confirmed the instrument is an OP-1 Field on November 3; firmware and physical effects remain unverified. Cardputer/IR effects and the revised real-headset interaction flow also need acceptance. Use [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md) to record the next run and retain its actual model/source labels, timing and effect evidence.

## Object canvas

`packages/protocol/src/canvas.ts` validates the game format (1–6 rounds, 2–3 choices, bounded text and scores, unique IDs) and contains its deterministic reducer. `apps/server/src/canvas/` generates drafts through Muse Spark and maintains atomic local `canvas-history.json` beside the device library: 64 objects, eight revisions each. Restore creates a new revision; generation and restore always return to preview. Starting or restarting is an explicit user action. Play state is shared in memory and returns to preview after server restart.

Canvas is independent of Forge, drivers and physical executors. A tagged object in Control mode may have no control connection. Only authorized owners/local clients can mutate the shared game; server-only `canvas.state` carries the authoritative result. Request IDs deduplicate actions, base revisions reject stale edits, and exact round IDs plus reducer phases prevent double scoring. Generation is scoped to the requesting client and object and is cancelled on selection/mode changes, disconnect or removal. Forget removes its history.

Quest's selected card provides Make a game, preview, Play, choices, feedback and restore. Ask Muse routes game creation/edits before the hardware offline gate; game undo cannot invoke physical undo. The companion places Object games below setup and Devices, with an explicit Open Canvas entry and contextual opening for newly started games; Hide Canvas persists through subsequent status updates. It renders the same document with a prompt box and revision restore. Both render plain data without scripts, audio or extra animation loops. Closed XR panels stay closed on Mac updates and reload current state when reopened. Ordinary-object recognition includes books in All and never invents unread content or a hardware connection.

## Interaction retrieval

The saved library remains the source of truth for completed device interfaces. `agent/interaction-references.ts` selects up to three bounded descriptive examples from active, enabled, visible versions, ranked by maker/model, category and compatible action labels. Forge generation and editing receive these as untrusted reference data; examples contain no executor or action IDs and never transfer verification. Request/current controls take priority, and the ordinary schema and binding checks still run.

`knowledge/interactions.ts` stores only gesture mappings accepted through Ask Muse's Apply flow. Exact reuse requires the same card, normalized request, complete hardware contract and live/fixture source, plus current verification. A fresh proposal is issued without planning/mapping calls only when it preserves current bindings; confirmation and Perform remain separate. Related compatible memories ground new mapping requests. Entries persist atomically (128 maximum), tolerate corrupt files, and are purged by Forget. Restoring an existing library device still restores its UI and gesture map without regeneration.

`research/cache.ts` wraps web search with exact-question, endpoint/model/instructions/effort isolation, seven-day expiry and explicit refresh. Only nonempty live results with HTTP(S) citations qualify. Fixture responses, failed calls and uncited answers are never cached. Cached results preserve original model, citations and research timestamp; physical verification is always independent. Both stores live beside `library.json`; tests can keep them in memory.


## Headset test follow-up

The direct virtual-instrument route is `target.select { virtual: "visual-synth", requestId }` followed by a sender-addressed `target.select.result`. The server requires Control mode and an online companion/sim with the explicit `ce-visual-synth` output. A stable card is bound to that executor and the requesting headset's camera; selection does not execute setup or arm controls. The client places a UI marker and a screen-aiming guide, not a fabricated object detection. Verification uses the centered camera region and freezes idle visual animation while testing commands, then restores it.

The Mac companion launches its visuals with an owner identifier. A low-frequency, same-origin renderer heartbeat advertises the virtual output only while that owner's display is visible. A closed or hidden renderer cannot acknowledge a successful virtual command. Sim fixtures retain their independent renderer path.

Both detectors share a three-candidate annotation budget. Per-frame overlaps are suppressed before placement; separate visible boxes cannot be merged solely because their estimated 3D positions are close. A selection pinch does not confirm depth, and an estimated YOLO pose cannot drag an already measured target. Stale estimated tags fade in Find devices, while the selected Control card stays mounted when the user looks away. This reduces stale labels; it is not room-mesh occlusion or proof of object-detection accuracy.

Hand feedback uses pooled joint instances and bone segments, with pinch and target feedback. Open menus, cards and the Ask Muse workspace stay fixed while being used; an explicit raised left palm/controller recall and Bring panels here recover their placement. Unverified actions are hidden from the main control card, and Ready requires a verified displayed action. Silent local Mac commands are unavailable instead of appearing to succeed.
