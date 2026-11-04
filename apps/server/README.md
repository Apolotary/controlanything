# ControlAnything server (the "malleable server")

Node 22.12+ / TypeScript (developed on Node 26). One process on the Mac: the WebSocket hub every client pairs with, the Meta model
adapters, and the **brain**: an explicit setup loop that turns a tagged device into verified, generated controls when the user asks.

```
npm run dev            # server + companion + Quest in watch mode (http://localhost:8787, https://<lan-ip>:8443)
npm run demo:sim       # the judge path: sim room + headset page, FIXTURE mode without a key
npm test               # whole repo (vitest); apps/server alone: npx vitest run apps/server
MUSE_RECORD=1 npx tsx apps/server/scripts/brain-live.ts [frame.jpg] [--pick synthesizer] [--card op-1-field]
```

## Principle

**Annotate by default.** `tag.add` identifies a selected device with Muse Spark and persists the tag. It does not link, learn or test anything. `mode.set` switches the space between Annotate and Control; `tags.state` reports Ready / Needs setup / Not connected from the current bridge presence.

**Setup only by request.** `control.setup` requires Control mode, a tagged device and an online bridge. It starts the chain below; the setup request permits verification commands, then `arm.confirm` separately enables the generated controls. Dispatch also checks these gates. Stop cancels setup, queued commands and automations and disarms controls. Returning to Annotate cancels unfinished setup, while completed arming is retained for returning to Control.

**Deterministic execution.** `control.event` → driver action → `exec.command` → MIDI / IR / local operation uses validated data and rate limits, without a model call. Voice transcription and edits still use models. The Quest's local YOLOX preview is separate from the server's SAM segmentation.

## The discovery loop (`src/agent/`)

| Step | What happens | Model |
|---|---|---|
| SCAN (`scan.ts`) | in Annotate, scan frames get the device prompts in parallel (`electronic device`, `ceiling light`, `synthesizer`; never people), masks become ≤ 64-point outlines, detections are deduplicated and matched to known targets; a pairing QR in view approves that pairing | `sam-3.1` |
| IDENTIFY (`identify.ts`) | the SAM crop (detail high) + the frame (detail low) → a DeviceCard with `json_schema`; maker/model stay "unknown" unless legible text supports them | `muse-spark-1.3`, effort low |
| LINK (`link.ts`) | the executor is picked by capability (midi / ir / local) from presence; USB port name and the MIDI identity request cross-check the camera's guess: `confirmed` / `consistent` / `mismatch` ("wrong device, refused") | none |
| RESEARCH (`research.ts`, `learn.ts`) | curated charts and the IR library in `data/devices/` (with provenance), learned IR codes from the device's own remote (one press per button, captured by a Cardputer or the sim), `web_search` as the fallback | `muse-spark-1.3` + `web_search` (fallback only) |
| DRIVE (`drive.ts`) | a declarative Driver (SPEC §3.2: actions with deterministic encodes, never code) with `json_schema`; validated against allowlists (CCs from the chart, IR codes from the library or the learned frames, no SysEx, ranges, rate caps); issues are fed back for repairs | `muse-spark-1.3` low → medium, `muse-wonder-1.0` guarded |
| VERIFY (`verify.ts`, `../oracle/`) | each action runs once for real; the camera oracle compares before/after frames inside the outline (mask-vs-ring luma, absolute luma at a fixed exposure, R/B for colour), the audio oracle compares feature windows; two consecutive confirmations; IR library candidates are cycled and an honest miss is reported as evidence | `sam-3.1` (outline only) |
| FORGE (`../gen3d/`) | the verified driver → hack set + 3D controls (`ui.spec`); controls bound to unverified actions stay disarmed | `muse-spark-1.3` |
| SKIN (`../gen3d/skin.ts`) | optional panel texture generated alongside controls; never gates arming; `GEN3D_SKIN=0` disables it | `muse-image-1.0` |
| ARM (`arm.ts`) | one-tap human confirmation (`arm.request` → `arm.confirm`), pinch-and-hold for irreversible drivers | none |
| CONTROL (`control.ts`, `dispatch.ts`) | `control.event` → hack → action → resolved op → executor; step planning for IR dimmers, latest-wins coalescing under the rate limits, undo, panic | none |

Every step is an `agent.step` with the model id, effort and latency; every model call is in
`GET /api/muse/calls`. In FIXTURE mode (no `MODEL_API_KEY`) the same loop replays recorded real answers
from `fixtures/recorded/` (SAM, identification, driver drafts, forge runs), each labelled `FIXTURE` with the
model that produced it.

### WIRE: Muse writes the glue (`wire.ts`, `wire-check.ts`, `wire-fixture.ts`)

After the driver exists, nothing connects the wearer's hands to it until the wearer asks. Nothing is prefetched
(`CE_PREFETCH=1` is a rehearsal-only opt-in) and nothing is pre-wired. On `wire.request {cardId, text, source}` the server
sets the card up first if it has no driver, then:

| Phase (`wire.progress.phase`) | What happens |
|---|---|
| `writing` | `muse-spark-1.3` (json_schema `{title ≤ 60, explanation ≤ 200, code, needs}`, effort low) writes the body of `function wire(s, out, mem)` from the request, the Signals API, the driver's actions and the device's capability-manifest hints; tokens stream to the headset and the companion as `codeDelta` (a model that cannot stream is replayed in ~8 chunks) |
| `validating` | ≤ 4 KB, no forbidden tokens (`import`, `fetch`, `eval`, `this`, timers, …), `new vm.Script` syntax, action ids only from the driver |
| `dry-run` | the program runs in an empty `node:vm` context (timeout, no globals) over four 120-frame traces (screen touch-drag, two-hand height sweep, pinch taps, idle): it must not throw, average < 2 ms/frame and emit ≥ 1 valid action on a trace for the signals it needs |
| repair → Wonder → template | one repair round with the findings, then `muse-wonder-1.0` behind the length guard, then a hand-written template titled `Template: …` (`source: 'template'`): never the default |
| `verifying` | driver actions the program uses that have not passed VERIFY are verified first (the visual synth's touch inputs come from its manifest and are verified on first use) |
| `ready` | `wire.ready {code, title, explanation, model, source, actions, needs}` to the headset and the companion |

The headset runs the program in its own sandbox and sends each output as `control.event` `wire:<actionId>`; the server
dispatches it through the driver like a dial (range clamp, `max_rate_hz`, latest-wins at ≤ 30 Hz for visual synth CCs,
physical devices keep their caps, armed + verified actions only, and only actions of the current `wire.ready`). Generated
code runs on the server only in the dry-run sandbox, never on the Mac. In FIXTURE mode (`MODEL_MODE=fixture`) recorded
wirings for "Touch the water" and "Hands as knobs" answer, labelled `FIXTURE`. `node --import tsx apps/server/scripts/wire-e2e.ts`
runs the whole flow against a fixture server on :8796.

### The room (`combos.ts`, `daemons.ts`, `heard.ts`)

Once two or more devices are verified, the server assembles `ui.spec` **`spec_room`** from their drivers
(no model writes a combo): **Blackout** (light off by IR + Mac muted + a receipt on the DevTerm; offline
devices are skipped and named; every step runs through the same oracles and produces its own evidence; one tap
confirms; UNDO restores the light and the volume and says the paper cannot be unprinted), **Breathe to tempo**
(a daemon: the light's brightness follows the synth's MIDI clock, or a bpm set by voice or the menu, as a sine
no faster than 0.5 Hz, written at ≤ 1 Hz under the IR cap; `daemon.status` reports it) and **Say line** (the
Mac speaks its driver's line, a microphone client records it (`sense.request` `audio-clip`) and
`muse-voice-transcribe-1.0` must hear it back; the evidence is the transcript similarity). In FIXTURE mode the
transcript recorded for that recording replays from `fixtures/recorded/transcribe/`.
`POST /api/agent/room/run {hackId}` and `/room/undo` drive them without a headset.

### Nature Remo bridge (`src/devices/remo.ts`)

A Nature Remo on the LAN (`Remo-XXXXXX`, mDNS `_remo._tcp`, local API `GET`/`POST /messages` with
`X-Requested-With: local`) is bridged by the server itself as a paired `remo` device with the IR capability: it
LEARNS (the learn window polls `GET /messages` at 4 Hz; every signal that differs from the previous one is a
capture, cleaned of receiver noise, and goes through the same replay → verify → label path as a Cardputer
capture) and SENDS (`IrOp` → raw µs → `POST /messages`, ≥ 1 s apart, under the IR cap). `pickExecutor` prefers
it for IR; the Cardputer stays the alternative and the pairing story. `REMO_HOST=<ip>` or `CE_REMO=1` (mDNS)
turns it on; it never probes the Remo at start-up, and **nothing is sent until `REMO_SEND=1`** (the user's
approval): until then every `exec.command` is acknowledged `refused`. Tests run against a mock Remo
(`fixtures/remo/`); the sim / judge path has no Remo and is untouched.

## HTTP views (besides the pairing API in `src/app.ts`)

```
GET  /api/agent/targets[/:cardId]   state machine, card, link, driver, verification, evidence
GET  /api/agent/scan/latest         newest scan result per camera client
GET  /api/agent/steps[?cardId]      the work log
GET  /api/agent/exec                every op sent and its ack
GET  /api/agent/profiles[/:id]      curated device data
POST /api/agent/select              {frameId, detId} | {cardId} | {deviceId}   (tag in Annotate; reopen in Control)
POST /api/agent/arm                 {armId, approve, hold?}                      (approver or localhost)
POST /api/agent/panic
POST /api/takes/:take                 the headset app's Save take hands its zip here (localhost only) -> apps/quest/public/takes/<take>/
```

## Environment

See `.env.example`. Brain-specific: `CE_SCAN_PROMPTS` (SAM prompts), `CE_IR_LEARN=1` (always learn the
remote), `CE_MAC_LOCAL=0` (disable the in-process Mac executor), `CE_MAC_SILENT=1` (the Mac stays silent: nothing audible runs, a recorded clip stands in for its voice), `CE_DATA_DIR` (registry location),
`MUSE_RECORD=1` (record live answers for replay), `CE_PREFETCH=1` (rehearsal only: Muse writes the Mac visual synth's driver as soon as the Mac appears; off by default), `CE_WIRE_TIMEOUT_MS` (the whole WIRE model phase, default 90 s, then the labelled template).

## Pairing API

Paired approvers can approve a QR code or passcode. Codes expire after five minutes and are single use; tokens are stored as hashes in `apps/server/.data/space.json`. Revoke with `DELETE /api/devices/:id`. HTTP is unencrypted: use a trusted LAN or bind `HTTP_HOST=127.0.0.1`.

```sh
curl -s -X POST http://<mac>:8787/api/pair/start -H 'content-type: application/json' \
  -d '{"name":"Cardputer","kind":"cardputer","capabilities":["ir","display"]}'
# Returns pairingId, display code, QR, expiresAt and pollSecret.
curl -s "http://<mac>:8787/api/pair/status?pairingId=<id>&pollSecret=<secret>"
# After approval: deviceId and deviceToken (returned once; store them).
```

Connect to `/ws` and send `hello` with `{ deviceToken }` in the protocol envelope. See [architecture](../../docs/ARCHITECTURE.md#3-protocol).
