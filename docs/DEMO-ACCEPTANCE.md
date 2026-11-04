# ControlAnything: demo acceptance

This is a procedure and evidence ledger, not a blanket pass claim. The current route is **Annotate → tag → Control → ask → Muse writes/deploys/tests → generated controls or hand interaction → Stop**. No Set up / Enable press is required before asking on the default agent path. The old chain remains behind `CE_AGENT=0`.

## Observed before this change (November 4)

| Path | Actual evidence |
|---|---|
| Tag → ask → deployed connector → AR knobs → acked CC21 → cancel/Stop | Fixture emulator, `scripts/e2e-muse-agent.mjs`. |
| Visual synth controller and water-touch program | User confirmed working on real Quest with live Muse; generation about 45s. |
| Browser musical synth Air Theremin | Real Quest, live generation about 37s. |
| OP-1 notes and CCs | Real Quest and physical instrument, after the user enabled MIDI receive on the OP-1. |
| OM 4 small pan/tilt/recenter | Physical Bluetooth commands through the direct test route; Muse-driven end-to-end hardware path still pending. |
| Palm + pinch wrist menu | Deployed before this work; wearer confirmation pending. |
| New instrument UI, reviewer camera demo and revised Buddy | Fixture/browser checks passed on this branch; new physical headset/phone/webcam acceptance remains separate. |

Do not combine unrelated probe times, screenshots or fixture receipts into one claimed continuous live run.

## Prepare without disturbing a session

- One live server on :8787/:8443; `CE_DEMO=1 CE_OSMO=web npm start` for an attended gimbal demo. Leave `CE_MAC_SILENT` and `CE_PREFETCH` unset. Sound is part of the demo; first browser gesture unlocks audio and one master volume/mute controls app sound. Keep physical instrument volume available.
- One paired executor-leading Chrome companion; preserve the existing pairing/workspace. For gimbal, preserve the Osmo Chrome tab on :8799. USB-C is power; gimbal control is Bluetooth.
- Keep one Quest tab. Never launch another tab, reload while in AR, or restart a live server without coordinating with the wearer. Stage development output in `/tmp`; the user deploys. Never build into a dist currently serving lazy chunks.
- Every runtime model must be Meta. Keep live, fixture, library and template sources visibly distinct. A template must be explicit, never an undisclosed replacement.

## Continuous wearer route

| Step | Action | Required observation |
|---|---|---|
| A1 | Enter AR in Annotate; choose Electronics / Objects / All | SAM outlines objects. Camera/hands work, no competing tab. Measure current Annotate performance. |
| A2 | Pinch an object and wait | It tags/identifies and stays in Annotate. No default synth redirect, setup, commands or prefetch. |
| A3 | Deliberately choose Control and the tagged object | Ask Muse appears immediately. Missing companion/transport has a clear Connect Mac or device instruction. |
| A4 | Speak/choose what the hands should do | Exact request stays on that object. Muse's actual tool/code/progress streams; no interaction exists before the ask. |
| A5 | During generation, choose Stop Muse once | Generation cancels; no late connector or readiness survives. Ask again deliberately. |
| A6 | Watch deploy, test and finish | Startup/errors and actual acknowledgements are inspected. Generated controls bind only declared actions; bad output is rejected rather than called success. |
| A7 | Play the generated instrument | OP-1 keys/pads produce bounded notes; encoders have reachable targets. XY water interaction produces visible outgoing feedback. Poke/press works; pinch-drag is optional. Code card does not cover controls. |
| A8 | If hand code needs a screen, capture top-left/bottom-right calibration | Deliberate corner progress; no screen output before calibration. Touch splash corresponds to real finger location and pressure releases on lift/loss. |
| A9 | Turn head and briefly lose tracking | Workspace is stable; no accidental wrist menu or target switch. Loss/return does not replay old notes or restart a retired program. |
| A10 | Both palms Stop, then ask again | Current program/connector/queued output retires. The selected device remains available. Another ask creates another interaction. |
| A11 | Raise flat left palm deliberately, or palm + pinch | Menu opens intentionally, stays closed while a control owns the hand, and closes after selection. Wrist Stop all and Exit remain reachable. |
| A12 | Stop all and Exit | Sounds/notes and connectors stop; no automatic resume. Exit releases the session cleanly. |

Retain build, headset/browser version, selected object, request/wiring IDs, exact generated source/model, executor receipts and uncut clip. Time selection, model generation, calibration and visible/audible response separately. Real hardware output and comfort remain distinct from bytes and emulator success.

## Optional demos

**Visual synth:** explicitly choose More → Demo: visual synth, then ask. The authored renderer/manifest supports Muse-written connector and hand glue. Verify water splash/wake and water/UI sound. Visual synth is never silently substituted for a physical laptop.

**Music / OP-1:** explicitly choose the software Music instrument or the actual physical OP-1. Ask before playing. Check shared mute, bounded note duration, release, tracking loss and Stop. Software analyser activity is not heard sound or physical MIDI proof. For OP-1, enable MIDI receive on the instrument and confirm actual output/channel/parameter. See [hardware procedure](HARDWARE-DEMO.md).

**OM 4:** use connected Bluetooth and begin with small moves. A successful rotate reply means accepted command, not measured position: the live angle layout is unconfirmed. Mock angles must say mock. Verify Muse-generated gimbal controls on the actual unit before claiming the end-to-end hardware route.

**Buddy:** greet/pet/high-five and show an object intentionally. Capture should present an accurate preview with retake/send; holding up a hand alone must not silently take a picture. Show a virtual object too and check its animation/reaction. Browser/OS speech is allowed; no foreign voice model.

**Reviewer without headset:** use the [mobile/laptop demo](REVIEWER-DEMO.md), with opt-in camera and touch/mouse. Record which device/browser and whether native immersive AR or inline camera fallback was used. An inline camera overlay is not world-tracked Quest passthrough or native hand tracking. Test denied permission, retry, retake, Stop and camera-off.

## Software checks on staging

Use one separate fixture server/data directory on 8796+ (not 8787, 8443 or 8799). Muted automation is allowed. Heavy browser runs are serialized with `research/e2e-lock.sh` when available.

```sh
npx tsc -p apps/server/tsconfig.json
npx tsc -p apps/quest/tsconfig.json
npx tsc -p apps/companion/tsconfig.json
npx tsc -p packages/protocol/tsconfig.json
(cd apps/quest && npx vite build --outDir /tmp/ce-stage-quest --emptyOutDir)
CE_QUEST_DIST=/tmp/ce-stage-quest node scripts/e2e-muse-agent.mjs
npx vitest run apps/server/src/devices/osmo/bridge.test.ts
node scripts/audit-public.mjs
```

Record actual result and screenshot paths in the task's completion receipt. A scripted fixture is no-credit software validation; it does not prove a new live model decision, real microphone transcription, device sound or Quest frame timing. Target headset rendering: p95 frame time ≤13.9ms (72fps), missed frames <5%, draws ≤120. Desktop renderer counters are useful, but cannot establish a Quest frame budget.

## Recovery and source boundaries

- No camera: keep one tab, read the explicit permission/retry explanation and reload only outside AR.
- No Mac/port: follow Connect Mac / exact port guidance; never claim delivery while offline.
- Failed/cancelled generation: keep actual error/source. Retry explicitly; do not auto-install a template.
- Wrong target: Stop and select/correct the intended object. A physical request must not redirect to a software instrument.
- Screen moved: Stop, recalibrate and explicitly ask/restart. SAM does not provide the calibrated plane.
- No visible/audible response: inspect current connector logs, executor ack and real device. No reliable angle or no analyser receipt is not proof that the hardware failed.
- Set up / Enable instructions apply only when deliberately testing `CE_AGENT=0`; they are not prerequisites for the current Muse-agent route.

Historical pre-agent dial/Perform measurements are retained in local research/handoff archives. They must not be represented as acceptance of newly expanded UI or reviewer modes. Publishing, pushing, deleting data and public visibility changes require the user's approval; development verification does not authorize them.

## Branch verification — November 4

On `codex/reviewer-demos-and-hardening`, all workspace typechecks and staged Quest/companion builds passed. The final focused regression run passed **352 tests in 24 files**. The known unrelated assistant-panel test was outside that scope; this is not a whole-suite claim.

The instrument browser check passed an actual emulated key press → acknowledged note, both XY coordinates → outgoing feedback, visual CC21, mock gimbal pan and Stop. The cancellation check passed Stop Muse during generation. Whole emulator scenes measured **112 / 84 / 56 draw calls** for OP-1 / visual synth / mock gimbal, with at most three feedback draws. These are desktop rendering counters, not measured Quest frame time.

The camera reviewer check passed exact-preview JPEG sharing only after Show, Retake, camera-off, virtual objects, both generated software instruments, a 390px touch layout, cancellation across page hide and silent Buddy teardown. With a fake physical OP-1 Mac and mock gimbal present, reviewer work reached neither hardware route and preserved the canonical headset tag. Browser runtime errors: zero. The companion Details check passed running entry/actions/logs and Stop retiring the process.

One live **muse-spark-1.3** scratch run generated validated encoders, keys and a note visualizer in **30.4 seconds**, using a fake MIDI sink with no hardware or speech. All other new browser evidence is labelled fixture/synthetic. Actual mobile native AR, real webcam quality and comfort/frame timing of the new Quest UI still need attended checks.

Local screenshots and receipts are under `research/screens/2026-11-04-instruments/`, `research/screens/reviewer-2026-11-04/` and `research/screens/reviewer-companion/` (intentionally not public assets). See [generated instruments](GENERATED-INSTRUMENTS.md), [reviewer guide](REVIEWER-DEMO.md) and [publication review](SECURITY-REVIEW.md). The live server, headset tab and Osmo browser were not changed or reloaded. Nothing was pushed or published.
