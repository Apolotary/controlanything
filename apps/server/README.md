# ControlAnything server (the "malleable server")

Node 22.12+ / TypeScript (developed on Node 26). One process on the Mac: the WebSocket hub every client pairs with, the Meta model
adapters, and the **Muse coding agent**: it writes, deploys and tests device connectors after the user asks, then returns generated AR instruments and optional hand programs.

```
npm run dev            # server + companion + Quest in watch mode (http://localhost:8787, https://<lan-ip>:8443)
npm run demo:sim       # the judge path: sim room + headset page, FIXTURE mode without a key
npm test               # whole repo (vitest); apps/server alone: npx vitest run apps/server
MUSE_RECORD=1 npx tsx apps/server/scripts/brain-live.ts [frame.jpg] [--pick synthesizer] [--card op-1-field]
```

## Principle

**Annotate by default.** `tag.add` identifies a selected device with Muse Spark and persists the tag. It does not link, learn or test anything. `mode.set` switches the space between Annotate and Control; `tags.state` reports Ready / Needs setup / Not connected from the current bridge presence.

**Ask before interacting.** In the default agent flow, choose Control and ask Muse immediately. Muse Spark uses file, terminal, deploy and test tools to create a Node connector on the Mac. `finish` returns a validated 3D instrument and/or a sandboxed hand program. No connector or hand mapping is pre-wired. Stop retires the connector; a new ask starts a new request. See [the current architecture](../../docs/ARCHITECTURE.md) and [instrument format](../../docs/GENERATED-INSTRUMENTS.md).

**No headset required.** `/quest/reviewer.html` offers webcam/phone capture, Buddy and the same Muse connector flow with browser software instruments. It requests no hardware permissions. Native mobile AR is feature-detected; other browsers use the honest camera/touch fallback. See [the reviewer guide](../../docs/REVIEWER-DEMO.md).

**Agent engine.** The built-in loop (`muse-agent.ts`) is the default. `CE_AGENT_ENGINE=muse-code` is an opt-in engine where Meta's Muse Code CLI (`muse exec`, `muse-spark-1.3`) runs the agent loop and calls the device tools (`say`, `open_visuals`, `deploy_connector`, `test_action`, `finish`) over a loopback MCP server with a per-run token (`muse-code-engine.ts`). With no key, no Muse Code binary or in fixture mode it falls back to the built-in loop. `GET /api/agent/connectors` reports the engine that ran.

**Execution and permissions.** Runtime models are Meta models only. Hand/head tracking, system voices and browser audio are platform features. Generated Node connectors and Bash commands use the Mac user's OS permissions; this is a trusted local prototype, not a hosted untrusted-code sandbox. See [the security review](../../docs/SECURITY-REVIEW.md).

The setup/Enable pipeline below is the older **`CE_AGENT=0`** compatibility path. Its driver validation and deterministic execution remain useful, but it is not a prerequisite for asking Muse in the default flow.

## Legacy discovery loop (`CE_AGENT=0`, `src/agent/`)

Skip this section unless you set `CE_AGENT=0`; the default Muse-agent flow does not use these steps.

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

### Legacy hand-program WIRE (`CE_AGENT=0`)

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
GET  /api/muse/calls                every model call: model id, latency, tokens (localhost or a paired device)
GET  /api/agent/connectors          Muse's running connectors: entry file, process, actions, logs, engine (owner/localhost)
GET  /api/agent/targets[/:cardId]   state machine, card, link, driver, verification, evidence
GET  /api/agent/scan/latest         newest scan result per camera client
GET  /api/agent/steps[?cardId]      the work log
GET  /api/agent/exec                every op sent and its ack
GET  /api/agent/profiles[/:id]      curated device data
POST /api/agent/select              {frameId, detId} | {cardId} | {deviceId}   (tag in Annotate; reopen in Control)
POST /api/agent/arm                 {armId, approve, hold?}                      (approver or localhost)
POST /api/agent/panic
POST /api/takes/:take                 Save take uploads here (localhost only) -> CE_DATA_DIR/takes/<take>/; private, excluded from builds
```

## Environment

See `.env.example`. The server strips secret values (such as `MODEL_API_KEY`) from everything it sends to clients. `CE_AGENT_ENGINE=muse-code` selects the opt-in Muse Code engine. Brain-specific: `CE_SCAN_PROMPTS` (SAM prompts), `CE_IR_LEARN=1` (always learn the
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

Connect to `/ws` and send `hello` with `{ deviceToken }` in the protocol envelope. See [architecture](../../docs/ARCHITECTURE.md#runtime-components).
