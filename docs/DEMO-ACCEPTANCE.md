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
| G1 | Enter AR | Passthrough + calm HUD; no centre-of-view coach card; ≤ 5 HUD elements | | |
| G2 | Look at the MacBook | A thin ring/label on the Mac: *MacBook · pinch to control* | | |
| G3 | Pinch the MacBook | The Mac's status card turns into the full-screen visual synth **by itself** (no Mac click) | | |
| G4 | Wait (no action) | Setup ring around the Mac, 5 ticks filling; verified ≤ 10 s ("seen" or "verified by renderer"); never "0/5 · Setup stopped" | | |
| G5 | — | Two arc dials (Warp, Ripples) on the Mac screen's edges; Perform/Stop toggle | | |
| G6 | Pinch-drag the Warp arc | The Mac colour/warp changes live; the Mac's Warp gauge follows | | |
| G7 | Left fist + raise/lower right hand | Warp follows hand height; clutch ring on the fist | | |
| G8 | Left fist + push/pull right hand ~20 cm | Blue water with expanding ripples on the Mac; Ripples gauge follows | | |
| G9 | Open the left hand | Control pauses; the Mac keeps its last state | | |
| G10 | Stop (both palms out, or the Stop button) | Control stops; the Mac resets to its default look | | |
| G11 | Exit AR | Back to the page; no stuck panels | | |
| P1 | Head sweep left/right, 5 s, in Armed | `--sweep` shows no HUD element flipping; no visible blink | | |

Record: date/time, build (`git log -1 --oneline`), server mode, the setup verify label (camera/renderer), and the times *pinch → ring complete* and *pinch → first ripple*. Keep the uncut clips.

## 4. Performance (real Quest 3, Quest Browser)

Measure with `node scripts/quest-cdp.mjs --fps 450` (≈5 s at 90 Hz) in each state while worn. Then run `--sweep 5000` during a head sweep. Target: **fps at p95 ≥ 72**, missed frames < 5 %, draws ≤ 120.

| When / build | State | fps (mean) | p95 ms (fps) | p99 ms | missed | draws | tris | sweep flips | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Nov 4 04:00, `4a296f3` bundle (pre-WP1–3) | Control (visual synth tag locked, server down), on desk | 87.8 | 11.84 (84.5) | 24.1 | 1.8 % | 50 | 1,860 | 0 | 90 Hz session, 1 render/frame, 26 drawables (all transparent), heap 23 MB |
| | Annotate | | | | | | | | |
| | Armed | | | | | | | | |
| | Perform | | | | | | | | |

## 5. Mac renderer checks

| Check | Result | How |
|---|---|---|
| Keeps animating while visible but unfocused | **Pass**: 121 fps (120 Hz panel), same as focused | Headed Chrome (Playwright, normal occlusion flags), another window in front |
| Notification banner on screen | **Pass**: 121 fps, page stays visible | `display notification` (silent) during the measurement |
| Brief hide (Space switch, reload) | Commands still apply for 15 s (`visualPresence.recent()`). The advertised port flips honestly; the server's 15 s grace keeps setup alive. | Code path. Re-check on the real run. |
| Renderer self-report in `exec.ack` | **Pass** (fixture): Warp CC 110 → receipt `warp 0.866, visible true, frame 103`, `applied.source: renderer` | :8794 fixture server, headless Chrome |
| Server setup driven by renderer receipts | **Pass** (fixture, `CE_DEMO=1`, real companion, no headset camera): select → visuals auto-open → 5/5 *verified by renderer* → template forge → auto-armed, under 1 s | :8794 fixture server, fake Quest socket |
| Silent | No AudioContext or audio element in the renderer; `CE_MAC_SILENT=1` on the server | — |

## 6. If something fails

- **Visuals didn't open on pinch:** click **Open visuals** on the Mac card, or use `?visuals=1`. Then pinch again.
- **Setup stuck at the camera check:** the renderer self-report should still pass it ("verified by renderer"). If not, read `/api/agent/steps` and keep the clip.
- **Controls offline after a Mac hiccup:** bring the companion window to the front. Within 15 s nothing is lost.
- **Card duplicated or offline after re-pairing:** run `node scripts/demo-reset.mjs` (WP1), then pair again.

## 7. Run log

| Run | Time | Build | Result | Notes / clip |
|---|---|---|---|---|
| | | | | |
