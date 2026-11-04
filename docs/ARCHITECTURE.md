# ControlAnything: architecture

The current demo is **select → ask → Muse writes → validate/dry-run → calibrate → touch**. The source of truth is `packages/protocol`, `apps/server/src/agent`, `apps/quest/src/wiring` and `packages/vsynth`. The [README](../README.md) explains the user flow; [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md) records what has actually been observed.

## 1. Two layers and an explicit request

**Annotate:** Quest Browser supplies passthrough frames and WebXR poses. The Mac server calls Meta SAM 3.1 and returns outlines, boxes and labels. It is the only runtime object detector; prompts and label filters exclude people. The primary wrist palette provides Annotate / Control and Electronics / Objects / All. Pinching an object identifies and tags it while staying in Annotate. Neither laptop identification nor companion presence redirects it to the visual synth. Companion pairing opens on an explicit request rather than blocking annotation on entry.

**Control:** the wearer chooses this layer and the exact tagged device. Its card explains the required companion/transport; setup begins only after the wearer asks for it. Optional **More → Visual synth** explicitly chooses a separate software instrument, preserves physical tags, and opens the companion's WebGL renderer. The server obtains device knowledge, asks Muse for a declarative driver, checks effects and prepares controls. In `CE_DEMO=1`, an explicitly chosen, verified reversible visual target can arm without a separate Enable modal. Physical targets retain their setup and confirmation gates.

**Musical option:** ControlAnything Synth is a second software device (`ce-musical-synth`), audible by default once the first Mac gesture unlocks browser audio. A server-addressed `musical.open` request opens its panel; it cannot bypass browser autoplay. There is no separate Sound on gate. The virtual port is available while the panel is visible, unlocked, connected and in the executor-leading tab. Muse reads the capability manifest and writes the requested scale-note/gate and effect wiring through WIRE. No physical Web MIDI route or authored hand preset substitutes for that program.

Arming a driver is not hand wiring. The device card asks **What should your hands do?** The wearer chooses a chip or speaks. Only then does `wire.request` start generation. `CE_PREFETCH` is off by default; `CE_PREFETCH=1` permits driver/interface preparation for an explicitly disclosed rehearsal. It does not replace the per-request WIRE step.

## 2. Runtime boundaries

```text
Quest: camera + pose ─scan.frame─> Mac server: SAM 3.1
Quest: outlines <─scan.result──── Mac server
Quest: pinch ─target.select─────> link / research / Muse driver / verify / forge / arm
Quest: request ─wire.request────> Muse Spark writes JavaScript
Quest + Mac code view <─wire.progress─ writing / validating / dry-run / verifying
Quest <─wire.ready─────────────── accepted code + permitted actions + required signals
Quest: calibrate screen if needed, then restricted Web Worker runs the code
Quest: worker outputs ─control.event wire:<actionId>─> server action gate
Mac renderer <─exec.command────── validated operation; no per-frame model call
Server <─exec.ack──────────────── applied renderer state, frame and visibility
```

| Component | Path | Responsibility |
|---|---|---|
| Protocol | `packages/protocol` | Zod schemas, TypeScript types and generated JSON Schemas for messages, drivers, controls and wiring. |
| Server | `apps/server` | HTTP/WS :8787 and HTTPS/WSS :8443, pairing, Meta adapters, perception, driver generation, validation, dry-run, verification, action dispatch and static app hosting. API keys stay here. |
| Quest | `apps/quest` | WebXR camera and joints, AR selection/menu/card, code view, signal computation, screen calibration and generated-program Worker. Meta `@iwsdk/xr-input` handles pointing/poke/pinch; IWER supplies desktop emulation. |
| Mac companion | `apps/companion` | Pairing/status, full-screen visual instrument, shared wiring-source display and Web MIDI/Serial executors. One tab executes through Web Locks. It renders and dispatches device actions; it does not evaluate the generated wiring program. |
| Visual synth | `packages/vsynth` | Authored silent WebGL renderer and capability manifest. CC22/23/24 are touch X/Y/pressure; contact spawns a splash, motion leaves a wake, low pressure gives hover feedback. The effect engine is infrastructure, not Muse-generated shader code. |
| Musical synth | `packages/vsynth/src/musical*`, companion `musicalSynth.ts` | Authored monophonic Web Audio graph/manifest: scale CC16, gate CC17, cutoff CC74, resonance CC71, attack CC73, release CC72, delay CC91, programs 0–2. Muse generates the hand mapping after a request. |
| Gen3d | `packages/gen3d` | Declarative control format, validators, deterministic compiler and lower-level spatial renderer. Current main HUD uses a bounded established layout, rather than evaluating arbitrary scene code. |
| Sim | `apps/sim` | Virtual Mac/executors and camera/audio stand-ins for software checks. Its receipts cannot establish real Quest comfort or physical-device behavior. |

Other clients include Cardputer IR/Serial firmware, an iPhone client, DevTerm and the Osmo bridge. Their existence does not establish a working attended hardware demonstration.

## 3. Driver preparation and evidence

The setup chain is `LINK → RESEARCH → DRIVE → VERIFY ∥ FORGE → ARM`. A saved verified driver/interface may be reused with its source disclosed. A companion appearing normally updates connection status; it does not trigger model work unless rehearsal prefetch was explicitly enabled.

| Stage | Behavior |
|---|---|
| SCAN / IDENTIFY | SAM 3.1 segments frames. Muse Spark identifies the selected crop plus its context; names and models remain unknown without supporting evidence. |
| LINK | Match online executor capability and port. MIDI identity/name evidence can confirm, support or contradict the selected identity; merely finding a port does not prove an effect. |
| RESEARCH | Read supported capability manifests, reviewed device/MIDI charts, IR data and learned codes. Cited web prose cannot invent executable MIDI CCs. |
| DRIVE | Muse Spark returns declarative driver JSON. The server checks transport, action IDs, manifest/chart allowlists, ranges, encode operations and rate caps. A guarded Muse Wonder attempt or labelled template may follow a failed live attempt. |
| VERIFY | Try driver actions and preserve per-action evidence. Use deterministic camera/audio comparison where available; the virtual visual synth may use an honest renderer receipt when the camera cannot see a change. |
| FORGE | Muse writes semantic controls bound to the driver. Deterministic checks/repairs compile the description. Unverified controls cannot send actions. |
| ARM | Explicit confirmation ordinarily enables controls. `CE_DEMO=1` can auto-arm only the verified reversible silent visual target. |

A driver is data, not executable JavaScript. Its operations resolve to MIDI, stored/learned IR, local or supported bridge operations. No arbitrary network driver or undeclared CC is created by accepting prose.

Evidence labels distinguish **seen ✓** (camera), **renderer ✓** (the virtual renderer reports applied state), **acknowledged ✓** (transport acknowledgement only), and **not seen ✗**. An acknowledgement alone cannot demonstrate a physical lamp or instrument effect. Driver and interface provenance remain separate from the wiring source.

Musical receipts use `applied.source: musical-synth`, raw parameters and an actual Web Audio analyser snapshot (RMS, peak and frequency), sampled before master gain. These establish graph activity, not that a person heard sound or a physical synthesizer reacted. `?mute=1` forces local test output to zero. Live startup leaves `CE_MAC_SILENT` unset. A shared `audio.master` volume/mute controls Mac, Quest, procedural water/UI sounds and OS/browser voices. Audio contexts unlock at the first browser gesture. Both palms retire the current wiring and release its note while preserving the checked device for another ask; Stop all, hiding, disconnect and close discard notes/delay tails without automatic resumption. The note gate has an eight-second cap. Real-headset listening remains separate acceptance.

## 4. WIRE: generated JavaScript

`apps/server/src/agent/wire.ts` owns the explicit selected-card request, epochs and authorization. Its normal program writer is `MuseBridgeHarness` in `agent/muse-harness.ts`: a bounded native Meta tool-call loop on the Mac server. Muse inspects the connector and actual signal API, submits `{title, explanation, code, needs}` to real validation/dry-run, repairs failures, and finishes the exact checked artifact by hash. Streamed code goes to both clients. Device verification remains separate and precedes `wire.ready`. Failure installs no implicit template. Fixture mode runs a labelled scripted tool conversation through the same dispatch/checks. The older direct structured-output helper remains separate from the normal assembled bridge. See [harness boundaries and receipts](MUSE-HARNESS.md).

`code` is the body of `function wire(s, out, mem)`. The program reads signals, retains small state in `mem`, and calls only `out.set(actionId, value)` or `out.trigger(actionId)`.

| Signals | Meaning |
|---|---|
| `s.t`, `s.dt` | Program time and frame delta. |
| `s.right`, `s.left` | Nullable tracked-hand signals: height, forward push, side, pinch, pinch tap, fist/open/palmOut and speed. Signals come from WebXR joints, not another model. |
| `s.screen` | Nullable fingertip position relative to the calibrated selected screen: `u`, `v`, `inside`, distance, touching, hover, velocity and handedness. |

The server limits source to 4KB, checks syntax and forbidden capabilities, rejects unknown driver actions, and runs synthetic hand/screen traces in a restricted `node:vm` context. The dry-run requires valid output and a frame-time budget. It then verifies any used driver actions that still need evidence before publishing readiness. A dry-run is a software check, not a physical sensor or device check.

On the Quest, `apps/quest/src/wiring/runtime.ts` creates a dedicated blob Web Worker. Network/storage/worker APIs are blocked, generated source is checked again, and the program has no DOM. Main-thread output gating allowlists actions, clamps values and limits their rates with latest-value coalescing. Repeated exceptions/overruns stop it; a watchdog terminates a non-returning call. The server independently checks current wiring, driver, arming, verification and execution limits before dispatch. This bounded prototype is not a general-purpose hostile-code execution service.

**Execution location:** normal generated-program execution is on the **Quest Worker**. The server evaluates it only for dry-run validation. The Mac companion never evaluates that program; it receives validated device operations.

`wire.ready` supplies the verified program's action descriptions and required signal names. Touch programs request screen calibration before starting. Hand-only requests do not require a screen. A new request stops the old program while Muse writes its replacement. Both palms out sends a request-scoped `wire.stop`: it revokes pending/current wiring and queued outputs, releases known browser pressure/note gates, and preserves the selected verified device for Ask again. Owner/request/wiring IDs reject stale stops, readiness and outputs; old verification cleanup cannot restore into a newer request. Wrist Stop all remains a full panic/disarm in either layer. Session and connection boundaries also withdraw execution. The acceptance run checks these boundaries rather than assuming a ready message proves them.

The current Quest supplies a fresh request ID on every ask and includes its request/wiring IDs with Worker outputs. The protocol still accepts older epochless clients; the new output-epoch guarantee applies to correlated requests, not those compatibility clients. Physical devices do not receive speculative release CCs: scoped release is defined only for the authored browser instruments. Use full Stop all and the reviewed hardware procedure for a physical instrument.

## 5. Touch calibration and rendering

The wearer captures top-left and bottom-right screen corners by holding a fingertip still at the prompts. `apps/quest/src/gestures/screen-calibration.ts` computes a plane; `screen-plane.ts` stores a device-specific plane and rejects invalid reuse. This is wearer calibration, not SAM-estimated depth. Recalibrate after moving the display or changing the room reference.

The authored signal layer exposes screen coordinates, signed distance and near-contact state. Muse chooses how these drive the visual synth's published touch controls. A typical touch program sends X and Y before pressure, returns pressure to zero when the hand lifts/disappears, and sends no touch while outside the calibrated region. Those details must be visible in the generated source and demonstrated on the real display.

The current renderer supports touch splashes/wakes across patterns. Ripple intensity is a separate parameter; it does not by itself prove that a fingertip touched the correct position. The key acceptance evidence is correspondence between the real finger, the calibrated screen point and the rendered splash/wake.

## 6. Protocol and observability

All WebSocket messages use `{v:1,type,id,ts,from,to?,payload}`. The hub authenticates identity and stamps the sender. Relevant messages:

| Messages | Purpose |
|---|---|
| `hello`, `welcome`, `presence`, session-claim/supersession | Authenticated clients and a single active headset owner. A duplicate tab must release its camera and stop sending controls. |
| `scan.frame`, `scan.result`, `tag.add`, `target.select` | Camera perception, tags and deliberate device selection. |
| `control.setup`, `agent.step`, `driver.spec`, `driver.status`, `verify.result`, `ui.spec`, `arm.*` | Setup, source, evidence and control readiness. |
| `visual.open`, `musical.open` | Server-addressed requests to show the selected Mac instrument. Musical open never grants sound permission. |
| `wire.request {requestId,cardId,text,source}` | Explicit chip, voice transcript or text request with a fresh client epoch. |
| `wire.progress` | Card/wiring IDs, phase, model, source, code append/replacement, title, explanation and issues. |
| `wire.ready` | Accepted code, source/model, allowed action IDs/ranges/rates and needed signals. |
| `wire.stop`, `wire.stopped` | Owner/epoch-scoped stop and release result, preserving the verified device for another ask. |
| `control.event` with `widgetId: wire:<actionId>` | Worker output with its actual request/wiring IDs through the verified action route. |
| `exec.command`, `exec.ack`, `sense.request`, `sense.result` | Execution and measured evidence. |
| `panic`, `control.cancel` | Full Stop all/disarm or device setup cancellation. |

Inspect `/api/health`, `/api/muse/calls`, `/api/agent/targets`, `/api/agent/steps` and `/api/agent/exec`. Match a demonstration to its actual card, driver, wiring, sources, verification and timestamps. Do not combine unrelated live logs and fixture footage as if they were one run.

## 7. Models, libraries and reuse

All runtime AI calls use Meta models: SAM 3.1, Muse Spark, guarded Muse Wonder, Muse Image and Muse Voice Transcribe. The card's hold-to-talk goes to Muse Voice Transcribe. Buddy uses Spark text and Image stickers. WebXR tracking, QR decoding, before/after numerical oracles, the renderer and macOS/iOS system speech are OS/browser features or deterministic code. See the [README model table](../README.md#meta-model-calls-vs-os-and-browser-features).

The device library stores accepted identity, driver, interface and their evidence. Related accepted interfaces can ground new control generation without transferring verification. The older lab gesture-map retrieval path is separate from WIRE: its ability to restore a saved mapping must not be described as freshly generated wiring. On the default WIRE path the wearer asks for each new interaction.

`MUSE_RECORD=1` stores labelled model responses for reproducible fixture runs. No-key fixture mode can replay them; an original model name does not make a replay live. Opt-in Quest take recordings preserve video, head/hand telemetry, gaps and reference-space boundaries. Motion lab reviews/exports these; it does not execute recorded commands or turn tracking estimates into validated training ground truth.

## 8. Verification and current limits

The muted emulator checks exercise the real app/server/Worker/control route with simulated camera and executor input. `scripts/e2e-judge.mjs` is the integrated golden path; `apps/server/scripts/wire-e2e.ts` checks WIRE over WebSocket. Use a separate fixture server/data directory and serialize heavy checks. They do not measure real SAM accuracy, Quest frame rate, calibration comfort or physical display correspondence.

Historical evidence remains scoped:

- The November 4 pre-WIRE real-headset run reached about 81 fps at p95 in Control/Perform, with 100/100 renderer-applied commands; its Annotate performance was below target while the since-removed local detector was active.
- A separate live Muse WIRE probe streamed Touch the water in 14 code deltas and reached ready in 8.1 seconds; Hands as knobs took about 11 seconds. This is generation/validation timing, not total wearer latency.
- The current ask/code/calibrate/touch route needs its own real-Quest run and Annotate remeasurement after the SAM-only change.
- Physical OP-1 Field, Osmo and IR effects remain separate acceptance gates. A mock, port discovery or byte acknowledgement is insufficient.

The main HUD is a bounded Horizon-style shell with authored layout, generated descriptions and generated wiring. It does not promise arbitrary generated 3D meshes, universal device control or calibration-free touch. The normal route has large request buttons and no side dials or manual Perform button. Dials and legacy Perform are available only when deliberately enabled with `?perform=1`. Sustained request reading uses a separate flat panel, placed once about1m ahead and below eye level; the normal workspace clears while it is open. That reader remains inside the immersive session.

Canvas, older assistant/gesture-map experiments and other lab UI remain off the primary path behind `?lab=1`. Buddy and Motion lab have their own evidence boundaries. Submission claims should describe only the paths actually demonstrated.


## Object-first presentation

The default device invitation prioritizes hold-to-talk, with one silent example; Ideas and Details are local presentation states. The quick wrist menu exposes Find objects/contextual Ask Muse plus More and persistent Stop all/Exit. Utilities remain one level away. Writing/checks and the initial generated explanation appear automatically. When the wiring controller collapses the code view, the HUD clears duplicate forms into one noninteractive cue that retains the actual generated explanation and source. Its pointer events and hand-UI capture are disabled. On-demand code inspection never changes server authorization. This presentation layer does not add gesture mappings, generation or execution authority.
