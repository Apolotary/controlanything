# Mac companion

Open `/companion/` in Chrome on the Mac. The server serves the built app on the same origin as its API and WebSocket.

The main view shows one sentence about the agent's current work and the paired devices' online state. Enter a device's pairing code to approve it, or use Approve / Deny in its request sheet. The localhost browser pairs as the owner automatically; other browsers show their own code for approval.

Three corner pills enable MIDI, Cardputer serial and microphone capture. The first activation uses a click for browser permission. Previously granted bridges reconnect in the executing tab. An active microphone or Cardputer pill stops that bridge; an active MIDI pill opens its settings in Details. Microphone capture feeds a zero-gain output, so it does not play back audio.

**Details** contains arm approvals, generated drivers, commands and acknowledgements, Meta model logs, physical verification evidence, device connections and revocation, IR learning, input selection, monitors and the MIDI test page. Stop all controls sends the existing panic command. Only one companion tab holds the executor role.

- `?stage=1` enlarges the sentence, device names and pair field for recording.
- `?replay=1` runs a local scripted demonstration. It opens no server connection, requests no hardware permissions, and never claims or attaches the executor. Its arm approval is simulated locally.
- `?spike=midi` opens the standalone MIDI test page.
- `?pair=1` starts pairing this browser again.

All visual tokens live in `src/tokens.css`; Inter is served locally. Sheets and the drawer use 180 ms motion, status changes cross-fade over 200 ms, and the working dot pulses once every two seconds. Reduced-motion preferences disable these animations.

## Checks

```sh
npm run typecheck
npx vitest run --project @ce/companion
npm test
npm run build -w @ce/companion
npm run build
```

The tests cover status mapping, pairing and presence, replay isolation, MIDI execution and acknowledgements, Cardputer forwarding, and muted audio capture with mocked hardware. Live hardware verification still needs the paired devices and browser permissions.
