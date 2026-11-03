# Mac companion

Open `/companion/` in Chrome on the Mac. The server serves the built app on the same origin as its API and WebSocket.

The companion uses the approved dark desktop layout at every system appearance setting. Home shows the headset connection and device rows; the Now card appears when there is activity to show. Devices focuses the same list. Details contains the selected device’s driver, Recording and Spec tabs, physical Checks, model timings, approval requests, and bridge connections. Activity contains system, MIDI, and serial monitors, automations, and the add-device QR.

The visual synth is the first demo path: choose **Open visuals**, keep its window visible, then use **Menu → Try visual synth** in the headset. The companion advertises the virtual output only while its own visible renderer sends a heartbeat; closing or hiding it reports disconnected. This needs no USB MIDI permission and does not select or enable headset controls automatically. Follow **Set up control → Enable controls → Perform**, hold a left fist and move the right hand.

The sidebar keeps the current model, connection state, and Stop all available. The product display name lives in `src/ui/product.ts`. Dark tokens live in `src/tokens.css`; the system font is preferred, with locally served Inter as a fallback. Code, IDs, pairing codes, and model metrics use the monospace stack. Reduced-motion preferences disable transitions and progress animation.

Open `/pair` to pair a fresh browser with Quest 3 using its QR or code. In the headset, look at the QR or choose **Type code**; **Menu > Pair a helper device** reopens pairing. Codes refresh automatically. A saved identity survives reloads and revisiting `/pair`. Home confirms **Paired with Quest 3** and asks you to put on the headset and tag the devices you want to use. In AR, tag devices in **Find devices**, then open **Menu > Use devices** when ready.

Pairing does not request USB MIDI permission or start synth setup. Device-specific MIDI guidance appears only after an explicit synth setup request; **Allow USB MIDI** and the manual Connections actions retain their browser permission flows. Previously granted bridges reconnect only in the executing tab; other tabs show standby. Microphone capture feeds a zero-gain output. Stop all uses the existing protocol command, and Now’s Stop cancels the matching active setup run.

For the silent demo, use **Open visuals** on Home, keep that screen visible and the companion open, then choose **Menu > Try visual synth** in the headset. Center the screen in the camera guide, set up control, choose **Enable**, then **Perform**. The virtual output belongs to the companion that opened the screen; it becomes disconnected immediately when hidden or closed, or after four seconds without a renderer heartbeat. Opening `/vsynth/` directly without its companion owner is a standalone preview. These steps do not request USB MIDI access or produce audio.

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
