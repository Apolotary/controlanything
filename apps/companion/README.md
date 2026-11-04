# Mac companion

Open `/companion/` in Chrome on the Mac. The server serves the built app on the same origin as its API and WebSocket.

Unpaired, it is one card: a QR code, the pairing code, its expiry and *Waiting for Quest 3*. Paired, it reads *Paired with Quest 3* plus one sentence, then **Open visuals · Musical synth · Details · Stop all**. Details holds the driver, recordings and spec, physical checks, model timings, approvals and bridge connections.

**The golden path:** keep this window visible (full screen is best) and, in the headset, pinch the MacBook's box, or choose *Visual synth* on the wrist palette. The companion opens the silent, full-screen visual synth **by itself** and advertises its virtual output while that renderer is visible. Its heartbeat and receipts let the server label a pass *renderer ✓* when the headset camera misses the change. With `CE_DEMO=1` this silent target can arm after verification; otherwise confirm Enable in Quest. Then ask Muse what your hands should do, watch the generated code and calibrate if requested. Hand interaction starts only after accepted wiring, with no separate Perform step. No USB MIDI permission is requested and the visual engine makes no sound. `/companion/?visuals=1` opens the visuals directly once paired.

**Musical synth** opens the separate **ControlAnything Synth** browser instrument. A Quest request can show it automatically but cannot enable sound: the present user must click **Sound on** on this Mac. Complete setup/confirmation in Quest, then ask Muse to write the hand-to-scale-note/gate and effect mapping. The authored engine provides two octaves of C minor, a filter, envelope, delay and three sound presets; it has no authored hand preset and never sends to physical Web MIDI. Stop, panel close, hiding or disconnect locks sound and clears delay tails. Use `/companion/?mute=1` for tests: even after explicit unlock, master output stays at zero while the analyser measures before it. Server `CE_MAC_SILENT` is a separate setting. Audible and real-headset acceptance are still pending; see [the checklist](../../docs/DEMO-ACCEPTANCE.md#optional-musical-route-separate-acceptance).

The sidebar keeps the current model, connection state, and Stop all available. The product display name lives in `src/ui/product.ts`. Dark tokens live in `src/tokens.css`; the system font is preferred, with locally served Inter as a fallback. Code, IDs, pairing codes, and model metrics use the monospace stack. Reduced-motion preferences disable transitions and progress animation.

Pair a fresh browser with Quest 3 by looking at the QR code from the headset in AR (the server reads it from the camera frame), or type the code. Codes refresh automatically. A saved identity survives reloads. A pending pairing request from another client shows an Approve prompt; clear stale requests before recording.

Pairing does not request USB MIDI permission or start synth setup. Device-specific MIDI guidance appears only after an explicit synth setup request; **Allow USB MIDI** and the manual Connections actions retain their browser permission flows. Previously granted bridges reconnect only in the executing tab; other tabs show standby. Microphone capture feeds a zero-gain output. Stop all uses the existing protocol command, and Now’s Stop cancels the matching active setup run.

Opening `/vsynth/` directly, without its companion owner, is a standalone preview that executes nothing.

The first localhost browser can become the room owner and approve a headset code. Once a headset owns the room, a new Mac helper needs headset approval. Incoming pairing requests use an Approve / Deny sheet.

**Muse's wiring, on screen.** After the wearer asks what their hands should do ("let me touch the water"), the server streams `wire.progress` and then `wire.ready`: the JavaScript Muse wrote, its model, whether it is `live`, a recorded FIXTURE or a Template (no Meta model wrote it), and the notes of each phase (writing, validating, dry-run, verifying, ready). The Mac only *shows* it; the program never runs here.

- The calm card gets one status line (*muse-spark-1.3 is wiring your hands to the Visual synth…* then *Wiring ready: Touch the water*), a source chip and a small **See code** toggle.
- The full-screen visuals show the code streaming in a small monospace plate in the top-left corner while it is written, and let it go about 8 s after it is ready. It never takes pointer events.
- Details has a **Wiring** tab next to Driver: the current code, model, source, the request, what it needs (for example screen calibration) and what it drives, and a note per phase.
- Every redraw is keyed: a repeated message, an unrelated update or a stable state touches no DOM (the page stays flicker-free), and streaming code only appends.

- `?stage=1` enlarges status text for recording.
- `?replay=1` runs a display-only scripted demonstration without server connections, hardware permissions, or executor ownership.
- `?replay=wire` plays a scripted, FIXTURE-labelled wiring run (the code streaming in, validated, dry-run, ready) the same way.
- `?inject=1` exposes `window.__ceInject(message)` for tests and recording rigs: it feeds a server message to the page as if the server had sent it (schema-validated, nothing sent).
- `?spike=midi` opens the standalone MIDI tool.
- `?pair=1` starts pairing only when this browser has no saved identity.

## Validation

```sh
npm run typecheck
npx vitest run --project @ce/companion
npm test
npm run build -w @ce/companion
npm run build
```

Two Chrome checks (system Chrome through playwright-core, an own fixture server on `PORT`, default 8798; silent; run them through the shared e2e lock when other agents are working):

```sh
node apps/companion/e2e/touch-water.mjs   # CC22/23/24 tap, drag, hover into ?visuals=1: pixels, 4-15 ms to first ripple, frame times; screenshots in research/screens/touch-water/
node apps/companion/e2e/wiring-view.mjs   # wire.progress / wire.ready into the overlay, the calm card and the Wiring tab; idempotent DOM; research/screens/wiring-view/
```

Behavior tests cover neutral post-pairing guidance, explicit synth setup, pairing and QR refresh, reload recovery, permissions, standby tabs, navigation, selected-device checks, expanded measurement details, keyboard tabs, truthful connection chips, and Stop. Hardware paths use mocks; these tests do not establish physical synth verification.

Capture Pair before approval, paired Home before USB permission, Home with USB ready and an active check, Details with an expanded failed/successful check and Agent log, and Activity. Capture Home and Details at 1440 and 1024 pixels wide, also with the OS set to light appearance.

The implementation fills the browser viewport; Pair uses a simple title bar before sidebar navigation appears after pairing. Home retains a quiet paired footer; device-specific setup guidance appears when requested. Progress is indeterminate because the server does not publish a measured completion percentage.
