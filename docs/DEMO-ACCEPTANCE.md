# ControlAnything: current WIRE demo acceptance

Hardware: **Meta Quest 3 + MacBook**, with the paired companion showing the silent visual synth. This checklist is a procedure, not a pass claim. The old dial/Perform measurements below are historical; the new route needs a fresh record.

**Golden path:** Enter AR → SAM outline → pinch MacBook → setup → ask Muse → watch JavaScript stream → validate/dry-run/verify → calibrate two corners → touch the water → lift → Stop → Exit.

## Prepare once

1. Keep one live server on :8787/:8443, started with `CE_DEMO=1 CE_MAC_SILENT=1 npm start`. `/api/health` must report live mode for a live take. Leave `CE_PREFETCH` unset; prefetch is opt-in rehearsal only. Keep IR and all sound off. Close disposable e2e browsers before the wearer test.
2. Keep the existing paired data. Open the companion in Chrome, with one executor-leading tab. **Open visuals** must visibly open the instrument or explain why it cannot; bring the Mac screen into the wearer's view. Record driver and wiring provenance separately.
3. Connect Quest over USB and establish `adb reverse tcp:8787 tcp:8787`. Use the existing single app tab at `http://localhost:8787/quest/`. Reload with `scripts/quest-reload.mjs` only while AR is inactive; do not open a second tab with a new launch command.
4. Use `scripts/deploy-live.sh quest` / `companion` / `sim` for live asset updates. Do not empty a dist directory that an open AR session still needs for lazy-loaded chunks. Server/protocol changes require a coordinated server restart.
5. Sit 0.6–1m from the Mac with its display and both hands visible. Test a five-second Quest compositor recording and review it muted: it must contain passthrough **and** AR panels. The app's Record take is a separate video/pose artifact and does not capture the rendered AR UI.

## One continuous real-headset take

| Step | Wearer action | Required observation | Current run |
|---|---|---|---|
| W1 | Enter AR; look at the Mac | Camera and hands work; SAM 3.1 outline appears. No competing camera tab. Annotate frame rate is measured again after the SAM-only change. | Pending |
| W2 | Raise a deliberate flat left palm | Wrist menu is easy to target; Annotate / Control and filters are clear. It closes after selection and stays away from active control. | Pending |
| W3 | Pinch the MacBook box once | Same selected object continues through setup. Mac visuals open/recover; progress and source are visible. A generic electronic-device box may need identification, but should not silently require a second pinch. | Pending |
| W4 | Wait for setup, without dragging dials | Card asks **What should your hands do?** Hands do not drive the device yet. Driver verification is labelled camera / renderer / acknowledgement honestly. | Pending |
| W5 | Choose **Touch the water**, or hold-to-talk and ask for it | Exact request stays on the selected device. JavaScript streams into the AR code card and Mac code view; a live take is labelled Live with the actual model, not FIXTURE or Template. | Pending |
| W6 | Watch checking finish | Validating → dry-run → action verification → ready. Failed generation never appears as successful live generation. Retain source, model, code and relevant call/step/exec records. | Pending |
| W7 | Hold the fingertip still at highlighted top-left, then bottom-right corner | Each corner visibly progresses. Resting hands do not capture a corner by accident. No device touch output runs before calibration succeeds. Saved valid calibration may skip this step; capture one fresh calibration in the proof take. | Pending |
| W8 | Touch the screen, draw a slow line/circle, lift and touch elsewhere | Splash starts at the real fingertip location; wake follows motion. X/Y/pressure use verified driver actions. Lift and missing tracking release pressure. No dial steals screen contact; no separate Perform step is required. | Pending |
| W9 | Turn head, briefly hide the hand, return | No unrelated menu opens or target switch. Tracking loss stops interaction, and recovery is clear. Record latency and comfort separately from successful bytes. | Pending |
| W10 | Show both palms out / choose Stop; then Exit | Program and queued commands stop, pressure releases, and controls do not restart on a delayed ready message. Exit returns cleanly. | Pending |

Record build, headset/browser version, source/model per artifact, card/driver/wiring IDs, verify label, measured timings and uncut clip path. Time **pinch → driver ready**, **ask → wire ready**, **calibration duration**, and **touch → visible splash** separately. A fast generation probe is not total setup latency. Label edits or speed-up in the submission video.

## Software checks before inviting the wearer

Use a separate fixture data directory and unused port; never bind test servers to :8787/:8443. Serialize heavy browser checks. These commands establish software flow, not real-world accuracy:

```sh
npx tsc -p apps/quest/tsconfig.json
npx tsc -p apps/server/tsconfig.json
node --import tsx apps/server/scripts/wire-e2e.ts
PORT=8797 node scripts/e2e-wire-quest.mjs
PORT=8796 node scripts/e2e-judge.mjs
```

The integrated browser check must cover chip → streamed source → calibration → actual Worker outputs (`wire:cc22`, `wire:cc23`, `wire:cc24`) reaching the simulated Mac → Stop. For Mac source display, use `apps/companion/e2e/wiring-view.mjs`. Fixture replay remains visibly FIXTURE, even when the original recorded model was live.

## Optional musical route: separate acceptance

ControlAnything Synth is a browser instrument, not the physical OP-1 Field. Its authored sound engine supplies capabilities; Muse must write the requested note/gate and parameter mapping after the wearer asks. These checks remain pending until observed. Keep output muted for automation (`/companion/?mute=1` and Chrome's mute-audio flag); an analyser receipt measures the graph before that mute, not audible playback. `CE_MAC_SILENT=1` alone does not mute this browser instrument.

| Step | Action and required observation | Current run |
|---|---|---|
| M1 | Choose Musical synth in Quest. Its Mac panel opens automatically, sound remains locked and no verification note or hand interaction starts. | Pending |
| M2 | The present user explicitly chooses Sound on on the Mac. The port becomes available; complete setup and confirm controls in Quest. In automation, master gain must remain zero. | Pending |
| M3 | Ask Muse how the hands should play. Watch exact request, streamed source, checks and honest Live/FIXTURE/Template label. Setup alone must not install a hand mapping. | Pending |
| M4 | Use the generated gesture. Verify scale-note and gate changes, analyser pitch/level, release and tracking-loss behavior. Hand-only wiring needs no screen calibration. Audible behavior is an additional attended check only with the user's explicit permission. | Pending |
| M5 | Stop, close/hide the Mac panel, then disconnect/reconnect. Sound and delay tails stop; no old note resumes. A fresh Mac Sound on click and new accepted wiring are required before restarting interaction. | Pending |

`apps/companion/e2e/musical-synth.mjs` exercises this software route with the real companion graph, fixture Muse and emulated hands. Its result must be recorded separately from a live Meta generation or real-headset/audio pass.

### Software checks — November 4

The actual-pointer golden path passed in the emulator after these changes: no manual or hand interaction before asking, requested WIRE, fresh calibration, 41 fingertip touch operations on CC22/23/24, both-palms full Stop, and wrist Tutorial replay/Skip. Setup used labelled acknowledgement evidence after a fixture-camera miss; this is not a real display or headset acceptance.

The musical browser check passed with the real companion Web Audio graph and emulated tracked hands: all ten capability checks, explicit muted unlock, requested Worker program, height/pitch, pinch/release, tracking loss and full Stop/relock. Master output remained zero. A separate single-call live `muse-spark-1.3` probe generated a program that passed bounded synthetic height/pinch/release/hand-loss checks; no device commands ran in that probe. Neither check establishes attended sound quality or a live real-Quest interaction.

## Failure/recovery

- **Waiting for Muse:** show the current stage; don't describe default prefetch as a fix. Keep the actual waiting time in the source footage. Retry a failed request explicitly.
- **No Mac visuals:** bring the executor companion tab forward; use Open visuals and read its status. Preserve pairing; avoid clearing data as routine recovery.
- **Wrong/missing screen plane:** Stop, choose Recalibrate screen and capture both corners again. Recalibrate after moving the display or changing room reference.
- **Touching does nothing:** inspect current wiring/source, selected target, calibration and actual permitted actions. A dial or the old Perform demo is not a substitute for this acceptance step.
- **Camera failed:** check single-session ownership and existing permission/retry state. Keep one Quest tab; reload only outside AR.
- **Failed or cancelled wiring:** keep the error and source label visible. A labelled template can be demonstrated as a fallback, not represented as live Muse-written code.

## Evidence boundary and next footage

The earlier real-Quest run below demonstrated driver setup and dial/Perform command execution, not the new generated-code touch-water interaction. Separate live WIRE probes reported Touch the water ready in 8.1s and Hands as knobs in about 11s. The integrated real-headset run above remains pending until observed.

For the three-minute video, capture the continuous ask/code/calibrate take and a matched Quest/Mac touch-water take first. Buddy, a real Motion lab recording and physical OP-1 Field are separate checks. Don't claim a musical-synth/hardware/IR effect until its own output is observed. Keep sound off unless the present wearer explicitly enables it.

## Historical measurements: pre-WIRE route

The following records are preserved from November 4's earlier build. Their labels and timings must not be reused as passes for W1–W10.

### Historical performance (real Quest 3, Quest Browser)

Measure with `node scripts/quest-cdp.mjs --fps 450` (≈5 s at 90 Hz) in each state while worn. Then run `--sweep 5000` during a head sweep. Target: **fps at p95 ≥ 72**, missed frames < 5 %, draws ≤ 120.

| When / build | State | fps (mean) | p95 ms (fps) | p99 ms | missed | draws | tris | sweep flips | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Nov 4 04:00, `4a296f3` bundle (pre-WP1–3) | Control (visual synth tag locked, server down), on desk | 87.8 | 11.84 (84.5) | 24.1 | 1.8 % | 50 | 1,860 | 0 | 90 Hz session, 1 render/frame, 26 drawables (all transparent), heap 23 MB |
| Nov 4 10:29–10:30, HEAD b12469f, worn | Annotate, while a stale tab held the camera (38 samples) | 86.5 | 18.7 (53) | — | 10 % | 22 (88 max) | 13.5k | — | Camera failed ("Could not start video source"); fixed by closing the old tab |
| Nov 4 10:31, b12469f, worn | Control, camera on (29 samples) | 90.0 | 12.1 (82) | — | 0 % | 24–84 | 13.9k | — | |
| Nov 4 10:54, f3861cc+, worn | **Annotate**, camera on (7 samples) | 85 | 19.3 (52); worst 47 | — | 7 % | 24 (28 max) | 19.6k | — | **Below target.** CPU-side (camera + YOLO + upload), not draws. Lasts only the ~10 s before the pinch |
| Nov 4 10:55, f3861cc+, worn | **Armed** (42 samples) | 89.9 | 12.34 (81); worst 15.0 | — | 0 % | 50 (86 max) | 24.9k | 45 frames / 45 s (reticles, wrist palette) | **Pass** |
| Nov 4 10:56–10:57, f3861cc+, worn | **Perform** fist open / **live** (17 + 19 samples) | 90 | 12.05 / 12.40 (83 / 81); worst 14.7 | — | 0 % | 50–56 | 24.5k | — | **Pass**. Mac acks: 100/100 ok, renderer, visible; ack latency 1 ms p50, 46 ms p95 |

### Historical Mac renderer checks

| Check | Result | How |
|---|---|---|
| Keeps animating while visible but unfocused | **Pass**: 121 fps (120 Hz panel), same as focused | Headed Chrome (Playwright, normal occlusion flags), another window in front |
| Notification banner on screen | **Pass**: 121 fps, page stays visible | `display notification` (silent) during the measurement |
| Brief hide (Space switch, reload) | Commands still apply for 15 s (`visualPresence.recent()`). The advertised port flips honestly; the server's 15 s grace keeps setup alive. | Code path. Re-check on the real run. |
| Real run, live Muse, real Quest camera | **Pass**: 6/6 setup actions and 100/100 Perform commands acknowledged by the Mac renderer (`visible: true`, frames advancing). The headset camera missed the first change at this distance, so the renderer receipt carried verification | Nov 4 10:54–10:57, `/api/agent/exec` |
| Renderer self-report in `exec.ack` | **Pass** (fixture): Warp CC 110 → receipt `warp 0.866, visible true, frame 103`, `applied.source: renderer` | :8794 fixture server, headless Chrome |
| Server setup driven by renderer receipts | **Pass** (fixture, `CE_DEMO=1`, real companion, no headset camera): select → visuals auto-open → 5/5 *verified by renderer* → template forge → auto-armed, under 1 s | :8794 fixture server, fake Quest socket |
| Silent | No AudioContext or audio element in the renderer; `CE_MAC_SILENT=1` on the server | — |


### Historical run log

| Run | Time | Build | Result | Notes / clip |
|---|---|---|---|---|
| 1 | Nov 4 10:54:45–10:57 | HEAD after f3861cc (tab reloaded 10:54:39) | Pinch → armed in 3 s; Perform drives Warp, Ripples and Hue on the Mac; armed/perform 81 fps at p95; Annotate 52 fps at p95 | Stop (G10) and Exit (G11) not observed: at 10:57:34 the XR session went hidden (headset off or Home) while still armed, with no panic/Stop sent. Earlier attempt 10:29 failed: a stale Quest tab held the camera |
