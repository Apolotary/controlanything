# Mac companion

Open `/companion/` in Chrome on the Mac. The server serves the built app on the same origin as its API and WebSocket.

The companion uses the approved dark desktop layout at every system appearance setting. Home shows the headset connection, active work, and device rows. Devices focuses the same list. Details contains the selected device’s driver, Recording and Spec tabs, physical Checks, model timings, approval requests, and bridge connections. Activity contains system, MIDI, and serial monitors, automations, and the add-device QR.

The sidebar keeps the current model, connection state, and Stop all available. The product display name lives in `src/ui/product.ts`. Dark tokens live in `src/tokens.css`; the system font is preferred, with locally served Inter as a fallback. Code, IDs, pairing codes, and model metrics use the monospace stack. Reduced-motion preferences disable transitions and progress animation.

Open `/pair` to pair a fresh browser with Quest 3 using its QR or code. Codes refresh automatically. A saved identity survives reloads and revisiting `/pair`; the paired confirmation stays visible on Home. The first localhost browser can still become the room owner and approve a headset code. Incoming pairing requests use an Approve / Deny sheet.

Allow USB MIDI and the Connections actions retain their browser permission flows. Previously granted bridges reconnect only in the executing tab; other tabs show standby. Microphone capture feeds a zero-gain output. Stop all uses the existing protocol command, and Now’s Stop cancels the matching active setup run. No new device commands run as part of the redesign.

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

Behavior tests cover pairing and QR refresh, reload recovery, permissions, standby tabs, navigation, selected-device checks, expanded measurement details, keyboard tabs, truthful connection chips, and Stop. Hardware paths use mocks. The restricted sandbox cannot run socket-based server tests, schema-generation IPC, or browser end-to-end flows; these need the runner.

Capture Pair before approval, paired Home before USB permission, Home with USB ready and an active check, Details with an expanded failed/successful check and Agent log, and Activity. Capture Home and Details at 1440 and 1024 pixels wide, also with the OS set to light appearance. Run companion phases in `scripts/e2e-flows.mjs` for hotplug, second-tab standby, pairing revisit, and reload recovery.

The implementation fills the browser viewport; Pair uses the mockup’s simple title bar before sidebar navigation appears after pairing. It retains a quiet paired/setup footer on Home for the existing workflow. Small captions and accent-button text differ slightly from the mockup to meet AA contrast; progress is indeterminate because the server does not publish a measured completion percentage.
