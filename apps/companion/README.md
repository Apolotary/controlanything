# Mac companion

Open `/companion/` in Chrome on the Mac. The server serves the built app on the same origin as its API and WebSocket.

Unpaired, it is one card: a QR code, the pairing code, its expiry and *Waiting for Quest 3*. Paired, it reads *Paired with Quest 3* plus one sentence, then **Open visuals · Details · Stop all**. Details holds the driver, recordings and spec, physical checks, model timings, approvals and bridge connections.

**The golden path:** keep this window visible (full screen is best) and, in the headset, pinch the MacBook's box, or choose *Visual synth* on the wrist palette. The companion opens the silent, full-screen visual synth **by itself**, with Warp and Ripples gauges, and advertises its virtual output while that renderer is visible. The renderer's heartbeat and its receipts are what let the server label a pass *renderer ✓* when the headset camera misses the change. With `CE_DEMO=1` the controls arm themselves after verification. Without it, follow **Set up → Enable controls → Perform**. No USB MIDI permission is requested and nothing makes a sound. `/companion/?visuals=1` opens the visuals directly once paired.

The sidebar keeps the current model, connection state, and Stop all available. The product display name lives in `src/ui/product.ts`. Dark tokens live in `src/tokens.css`; the system font is preferred, with locally served Inter as a fallback. Code, IDs, pairing codes, and model metrics use the monospace stack. Reduced-motion preferences disable transitions and progress animation.

Pair a fresh browser with Quest 3 by looking at the QR code from the headset in AR (the server reads it from the camera frame), or type the code. Codes refresh automatically. A saved identity survives reloads. A pending pairing request from another client shows an Approve prompt; clear stale requests before recording.

Pairing does not request USB MIDI permission or start synth setup. Device-specific MIDI guidance appears only after an explicit synth setup request; **Allow USB MIDI** and the manual Connections actions retain their browser permission flows. Previously granted bridges reconnect only in the executing tab; other tabs show standby. Microphone capture feeds a zero-gain output. Stop all uses the existing protocol command, and Now’s Stop cancels the matching active setup run.

Opening `/vsynth/` directly, without its companion owner, is a standalone preview that executes nothing.

The first localhost browser can become the room owner and approve a headset code. Once a headset owns the room, a new Mac helper needs headset approval. Incoming pairing requests use an Approve / Deny sheet.

- `?stage=1` enlarges status text for recording.
- `?replay=1` runs a display-only scripted demonstration without server connections, hardware permissions, or executor ownership.
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

Behavior tests cover neutral post-pairing guidance, explicit synth setup, pairing and QR refresh, reload recovery, permissions, standby tabs, navigation, selected-device checks, expanded measurement details, keyboard tabs, truthful connection chips, and Stop. Hardware paths use mocks; these tests do not establish physical synth verification.

Capture Pair before approval, paired Home before USB permission, Home with USB ready and an active check, Details with an expanded failed/successful check and Agent log, and Activity. Capture Home and Details at 1440 and 1024 pixels wide, also with the OS set to light appearance.

The implementation fills the browser viewport; Pair uses a simple title bar before sidebar navigation appears after pairing. Home retains a quiet paired footer; device-specific setup guidance appears when requested. Progress is indeterminate because the server does not publish a measured completion percentage.
