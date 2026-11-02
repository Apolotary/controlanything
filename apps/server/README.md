# ControlEverything server (the "malleable server")

Node 22+ / TypeScript. One process on the Mac: the WebSocket hub every client pairs with, the Meta model
adapters, and the **brain**: a discovery loop that turns a thing the headset looked at into verified,
generated controls.

```
npm run dev            # server + companion in watch mode (http://localhost:8787, https://<lan-ip>:8443)
npm run demo:sim       # the judge path: sim room + headset page, FIXTURE mode without a key
npm test               # whole repo (vitest); apps/server alone: npx vitest run apps/server
MUSE_RECORD=1 npx tsx apps/server/scripts/brain-live.ts [frame.jpg] [--pick synthesizer] [--card op-1-field]
```

## Principle

**AI at compile time, deterministic runtime.** Meta models run only in the discovery loop; the control loop
(hand or voice → `control.event` → driver action → `exec.command` → MIDI / IR / local op) is plain code,
rate-limited, and under 1 ms of server time. Nothing reaches a device before VERIFY, and nothing is armed
before a human taps.

## The discovery loop (`src/agent/`)

| Step | What happens | Model |
|---|---|---|
| SCAN (`scan.ts`) | every `scan.frame` gets the device prompts in parallel (`electronic device`, `ceiling light`, `synthesizer`; never people), masks become ≤ 64-point outlines, detections are deduplicated and matched to known targets; a pairing QR in view approves that pairing | `sam-3.1` |
| IDENTIFY (`identify.ts`) | the SAM crop (detail high) + the frame (detail low) → a DeviceCard with `json_schema`; maker/model stay "unknown" unless legible text supports them | `muse-spark-1.3`, effort low |
| LINK (`link.ts`) | the executor is picked by capability (midi / ir / local) from presence; USB port name and the MIDI identity request cross-check the camera's guess: `confirmed` / `consistent` / `mismatch` ("wrong device, refused") | none |
| RESEARCH (`research.ts`, `learn.ts`) | curated charts and the IR library in `data/devices/` (with provenance), learned IR codes from the device's own remote (one press per button, captured by a Cardputer or the sim), `web_search` as the fallback | `muse-spark-1.3` + `web_search` (fallback only) |
| DRIVE (`drive.ts`) | a declarative Driver (SPEC §3.2: actions with deterministic encodes, never code) with `json_schema`; validated against allowlists (CCs from the chart, IR codes from the library or the learned frames, no SysEx, ranges, rate caps); issues are fed back for repairs | `muse-spark-1.3` low → medium, `muse-wonder-1.0` guarded |
| VERIFY (`verify.ts`, `../oracle/`) | each action runs once for real; the camera oracle compares before/after frames inside the outline (mask-vs-ring luma, absolute luma at a fixed exposure, R/B for colour), the audio oracle compares feature windows; two consecutive confirmations; IR library candidates are cycled and an honest miss is reported as evidence | none |
| FORGE (`../gen3d/`) | the verified driver → hack set + 3D controls (`ui.spec`); controls bound to unverified actions stay disarmed | `muse-spark-1.3` |
| ARM (`arm.ts`) | one-tap human confirmation (`arm.request` → `arm.confirm`), pinch-and-hold for irreversible drivers | none |
| CONTROL (`control.ts`, `dispatch.ts`) | `control.event` → hack → action → resolved op → executor; step planning for IR dimmers, latest-wins coalescing under the rate limits, undo, panic | none |

Every step is an `agent.step` with the model id, effort and latency; every model call is in
`GET /api/muse/calls`. In FIXTURE mode (no `MODEL_API_KEY`) the same loop replays recorded real answers
from `fixtures/recorded/` (SAM, identification, driver drafts, forge runs), each labelled `FIXTURE` with the
model that produced it.

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
POST /api/agent/select              {frameId, detId} | {cardId} | {deviceId}   (approver or localhost)
POST /api/agent/arm                 {armId, approve, hold?}                      (approver or localhost)
POST /api/agent/panic
POST /api/takes/:take                 the headset app's Save take hands its zip here (localhost only) -> apps/quest/public/takes/<take>/
```

## Environment

See `.env.example`. Brain-specific: `CE_SCAN_PROMPTS` (SAM prompts), `CE_IR_LEARN=1` (always learn the
remote), `CE_MAC_LOCAL=0` (disable the in-process Mac executor), `CE_MAC_SILENT=1` (the Mac stays silent: nothing audible runs, a recorded clip stands in for its voice), `CE_DATA_DIR` (registry location),
`MUSE_RECORD=1` (record live answers for replay).
