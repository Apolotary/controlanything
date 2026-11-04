# ControlAnything: demo acceptance (golden path)

Demo hardware: **MacBook + Meta Quest 3 only.** The Mac is both the companion (pairing, bridge) and the device being controlled: its full-screen, silent **visual synth**. This page is a checklist filled in from real headset runs, not a claim. A step passes only when it was seen on the real Quest with the real Mac screen.

Target: **Enter AR → pinch the MacBook → setup ring → arcs → fist + push/pull → ripples on the Mac → Stop**, smooth (≥ 72 fps at p95, no blink on a head sweep).

## 1. Before the run (Mac)

| # | Check | How | ✓ |
|---|---|---|---|
| M1 | One server on :8787, live mode, Mac silent | `curl -s localhost:8787/api/health` shows `"mode":"live"`. Server started with `CE_DEMO=1 CE_MAC_SILENT=1` (`CE_DEMO=1` makes the pinch set up and arm the visual synth by itself; without it the card asks for **Set up** and **Enable controls**). No other dev servers or e2e browsers running. | |
| M2 | Quest and Mac paired once; `.data` kept | The companion shows **Paired with Quest 3**. Don't clear the data dir before the take. | |
| M3 | Companion in its own Chrome window, full screen | Open `http://localhost:8787/companion/` in a separate Chrome window, then View → Enter Full Screen (⌃⌘F). The window shows only the pairing/status card. Details is behind the **Details** button. Close every other companion tab first: only one tab runs the executor, and a stray tab keeps that role. | |
| M4 | Do Not Disturb on, no other apps on that Space | Notifications don't stop the renderer (measured), but they show up in a screen recording. | |
| M5 | Fallback ready | `http://localhost:8787/companion/?visuals=1` opens the visual synth by itself once paired. Press **f** or double-click for element full screen. **Back to companion** returns. | |
| M6 | Screen recording ready, sound off | QuickTime or ⌘⇧5, recording the full screen, microphone off. | |

## 2. Before the run (Quest)

| # | Check | How | ✓ |
|---|---|---|---|
| Q1 | USB + adb reverse | `adb devices` lists the Quest. `adb reverse tcp:8787 tcp:8787`. | |
| Q2 | Page open | Quest Browser on `http://localhost:8787/quest/`. Reload only while AR is off. | |
| Q3 | CDP reachable | `node scripts/quest-cdp.mjs --state` prints the mode, HUD and socket (the adb forward is created on demand). | |
| Q4 | Headset awake on the desk (optional, for measuring without wearing) | `node scripts/quest-cdp.mjs --awake on`; undo with `--awake off` before wearing. Unworn, the headset may drop to Home after a while; the XR session survives (hidden) and resumes when you return to the browser. | |
| Q5 | Compositor capture | Video: Meta button → Camera → **Record video** (passthrough + AR UI). Stills: `node scripts/quest-cdp.mjs --screenshot out.jpg` (metacam, passthrough included; verified Nov 4). Test a 5 s clip first. | |

## 3. Golden path (one continuous take)

Seated 0.6–1.0 m from the MacBook, with the Mac screen and both hands in view.

| # | Wearer does | Must see (pass) | Run 1 | Run 2 |
|---|---|---|---|---|
| G1 | Enter AR | Passthrough + calm HUD; no centre-of-view coach card; ≤ 5 HUD elements | In AR 10:54:45 (after a page reload at 10:54:39); camera on, both hands tracked. HUD count not checked by instruments | |
| G2 | Look at the MacBook | A thin ring/label on the Mac: *MacBook · pinch to control* | YOLO **Laptop** box present (the pinch carried `label:"Laptop"`). Label wording not checked | |
| G3 | Pinch the MacBook | The Mac's status card turns into the full-screen visual synth **by itself** (no Mac click) | **Pass** 10:54:56: `target.select` → "Opening the Mac visuals…" → automatic re-select → ok (`autoSetup`). The renderer was drawing (frames 159→273 in the verify receipts) | |
| G4 | Wait (no action) | Setup ring around the Mac, 5 ticks filling; verified ≤ 10 s ("seen" or "verified by renderer"); never "0/5 · Setup stopped" | **Pass** 10:54:59: 6/6 *verified by renderer*. The camera saw no change on the first action (Δ −0.039) and was skipped after that. **Pinch → armed: 3 s** (`CE_DEMO=1` auto-arm) | |
| G5 | — | Two arc dials (Warp, Ripples) on the Mac screen's edges; Perform/Stop toggle | ui.spec "Visual Synth", 6 controls; armed card drew 50–86 draw calls. Not checked by eye | |
| G6 | Pinch-drag the Warp arc | The Mac colour/warp changes live; the Mac's Warp gauge follows | Controlling 10:55:46–10:56:06 (≈4.7 control events/s); every ack `applied.source: renderer, visible: true` | |
| G7 | Left fist + raise/lower right hand | Warp follows hand height; clutch ring on the fist | **Pass (wire)** 10:56:15–10:56:46 Perform live: CC71 Warp ×45 in the last 100 commands, all applied by the renderer | |
| G8 | Left fist + push/pull right hand ~20 cm | Blue water with expanding ripples on the Mac; Ripples gauge follows | **Pass (wire)**: CC21 Ripples ×38, values sweeping 104 → 83; renderer state `pattern 3` (Water) in the acks | |
| G9 | Open the left hand | Control pauses; the Mac keeps its last state | **Pass**: Perform live → paused at 10:56:39 and 10:56:46, re-engaged at 10:56:40 and 10:57:04 | |
| G10 | Stop (both palms out, or the Stop button) | Control stops; the Mac resets to its default look | | |
| G11 | Exit AR | Back to the page; no stuck panels | | |
| P1 | Head sweep left/right, 5 s, in Armed | `--sweep` shows no HUD element flipping; no visible blink | **Pass**: 45 s sweep, 45 of 4,032 frames changed. Only the pinch reticles (22/19 flips) and the wrist palette/layer buttons showing and hiding (4 flips each); no card or dial flipped | |

Record: date/time, build (`git log -1 --oneline`), server mode, the setup verify label (camera/renderer), and the times *pinch → ring complete* and *pinch → first ripple*. Keep the uncut clips.

## 4. Performance (real Quest 3, Quest Browser)

Measure with `node scripts/quest-cdp.mjs --fps 450` (≈5 s at 90 Hz) in each state while worn. Then run `--sweep 5000` during a head sweep. Target: **fps at p95 ≥ 72**, missed frames < 5 %, draws ≤ 120.

| When / build | State | fps (mean) | p95 ms (fps) | p99 ms | missed | draws | tris | sweep flips | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Nov 4 04:00, `4a296f3` bundle (pre-WP1–3) | Control (visual synth tag locked, server down), on desk | 87.8 | 11.84 (84.5) | 24.1 | 1.8 % | 50 | 1,860 | 0 | 90 Hz session, 1 render/frame, 26 drawables (all transparent), heap 23 MB |
| Nov 4 10:29–10:30, HEAD b12469f, worn | Annotate, while a stale tab held the camera (38 samples) | 86.5 | 18.7 (53) | — | 10 % | 22 (88 max) | 13.5k | — | Camera failed ("Could not start video source"); fixed by closing the old tab |
| Nov 4 10:31, b12469f, worn | Control, camera on (29 samples) | 90.0 | 12.1 (82) | — | 0 % | 24–84 | 13.9k | — | |
| Nov 4 10:54, f3861cc+, worn | **Annotate**, camera on (7 samples) | 85 | 19.3 (52); worst 47 | — | 7 % | 24 (28 max) | 19.6k | — | **Below target.** CPU-side (camera + YOLO + upload), not draws. Lasts only the ~10 s before the pinch |
| Nov 4 10:55, f3861cc+, worn | **Armed** (39 samples) | 89.9 | 12.35 (81); worst 15.0 | — | 0 % | 50 (86 max) | 24.9k | 45 frames / 45 s (reticles, wrist palette) | **Pass** |
| Nov 4 10:56, f3861cc+, worn | **Perform** fist open / **live** (7 + 15 samples) | 90 | 12.34 / 12.39 (81); worst 14.7 | — | 0 % | 50–56 | 24.5k | — | **Pass**. Mac acks: 100/100 ok, renderer, visible; ack latency 1 ms p50, 46 ms p95 |

## 5. Mac renderer checks

| Check | Result | How |
|---|---|---|
| Keeps animating while visible but unfocused | **Pass**: 121 fps (120 Hz panel), same as focused | Headed Chrome (Playwright, normal occlusion flags), another window in front |
| Notification banner on screen | **Pass**: 121 fps, page stays visible | `display notification` (silent) during the measurement |
| Brief hide (Space switch, reload) | Commands still apply for 15 s (`visualPresence.recent()`). The advertised port flips honestly; the server's 15 s grace keeps setup alive. | Code path. Re-check on the real run. |
| Real run, live Muse, real Quest camera | **Pass**: 6/6 setup actions and 100/100 Perform commands acknowledged by the Mac renderer (`visible: true`, frames advancing). The headset camera missed the first change at this distance, so the renderer receipt carried verification | Nov 4 10:54–10:57, `/api/agent/exec` |
| Renderer self-report in `exec.ack` | **Pass** (fixture): Warp CC 110 → receipt `warp 0.866, visible true, frame 103`, `applied.source: renderer` | :8794 fixture server, headless Chrome |
| Server setup driven by renderer receipts | **Pass** (fixture, `CE_DEMO=1`, real companion, no headset camera): select → visuals auto-open → 5/5 *verified by renderer* → template forge → auto-armed, under 1 s | :8794 fixture server, fake Quest socket |
| Silent | No AudioContext or audio element in the renderer; `CE_MAC_SILENT=1` on the server | — |

## 6. If something fails

- **Setup takes ~10–40 s instead of ~1 s:** the driver + controls prefetch starts when the companion connects and took ~40 s live (driver 15–19 s, then controls 21–29 s). Keep the companion connected for about a minute before the pinch.
- **The pinch only names the Mac:** a generic SAM box ("electronic device", not a detector "laptop") is identified first (~11 s live), then reads *Pinch to play the Mac visual synth*. Pinch it once more.
- **Visuals didn't open on pinch:** click **Open visuals** on the Mac card, or use `?visuals=1`. Then pinch again.
- **Setup stuck at the camera check:** the renderer self-report should still pass it ("verified by renderer"). If not, read `/api/agent/steps` and keep the clip.
- **Controls offline after a Mac hiccup:** bring the companion window to the front. Within 15 s nothing is lost.
- **Card duplicated or offline after re-pairing:** run `node scripts/demo-reset.mjs` (WP1), then pair again.

## 7. Run log

| Run | Time | Build | Result | Notes / clip |
|---|---|---|---|---|
| 1 | Nov 4 10:54:45–10:57 | HEAD after f3861cc (tab reloaded 10:54:39) | Pinch → armed in 3 s; Perform drives Warp, Ripples and Hue on the Mac; armed/perform 81 fps at p95; Annotate 52 fps at p95 | Stop (G10) and Exit (G11) not yet observed by instruments. Earlier attempt 10:29 failed: a stale Quest tab held the camera |
