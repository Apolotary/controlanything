# Mac companion

Open `/companion/` in Chrome on the Mac. The server serves the built app on the same origin as its API and WebSocket.

Unpaired, it is one card: a QR code, the pairing code, its expiry and *Waiting for Quest 3*. Paired, it reads *Paired with Quest 3* plus one sentence, then **Open visuals · Musical synth · Details · Stop all**. Details holds the driver, recordings and spec, physical checks, model timings, approvals and bridge connections.

**The golden path:** keep this window visible and select the real object in Quest. Choose Control, then ask Muse what you want. For the optional visual demo, choose **More → Visual synth** explicitly; the companion opens its renderer and advertises the exact software output. Muse writes and tests the connector before returning keys, XY surfaces, knobs or other controls. There is no setup/Enable ceremony in the default agent flow. Hand programs, when requested, run in the Quest Worker; calibration appears only when needed. `/companion/?visuals=1` opens the visuals directly once paired. Water touch has procedural splash/wake feedback after the first browser gesture unlocks audio.

**Musical synth** opens the separate **ControlAnything Synth** browser instrument. The first deliberate interaction on this Mac unlocks sound, with one shared volume/mute control; there is no extra Sound on button. Ask Muse to create the note/gate and effect mapping. The authored engine provides two octaves of C minor, a filter, envelope, delay and three presets; it has no authored hand preset and never sends physical MIDI. Stop, panel close, hiding or disconnect releases notes. Use `/companion/?mute=1` for unattended tests. Historical Quest water/theremin and physical OP-1 output were confirmed by the user; the revised rich UI still needs its own headset comfort/listening acceptance. See [the checklist](../../docs/DEMO-ACCEPTANCE.md#optional-demos).

**No headset?** The [camera/touch reviewer page](../../docs/REVIEWER-DEMO.md) runs its own browser software instruments and needs no separate companion tab. **Details → Muse connectors** on this Mac shows running connector files, actions and logs, with a scoped Stop button. The older setup/Enable flow remains only under `CE_AGENT=0`.

The sidebar keeps the current model, connection state, and Stop all available. The product display name lives in `src/ui/product.ts`. Dark tokens live in `src/tokens.css`; the system font is preferred, with locally served Inter as a fallback. Code, IDs, pairing codes, and model metrics use the monospace stack. Reduced-motion preferences disable transitions and progress animation.

Pair a fresh browser with Quest 3 by looking at the QR code from the headset in AR (the server reads it from the camera frame), or type the code. Codes refresh automatically. A saved identity survives reloads. A pending pairing request from another client shows an Approve prompt; clear stale requests before recording.

Pairing does not request USB MIDI permission or start synth setup. Device-specific MIDI guidance appears only after an explicit synth setup request; **Allow USB MIDI** and the manual Connections actions retain their browser permission flows. Previously granted bridges reconnect only in the executing tab; other tabs show standby. Microphone capture feeds a zero-gain output. Stop all uses the existing protocol command, and Now’s Stop cancels the matching active setup run.

Opening `/companion/vsynth/` directly, without its companion owner, is a standalone preview that executes nothing.

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
