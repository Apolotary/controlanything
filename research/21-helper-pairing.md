# Helper pairing demo

The headset must already be authorized in the room through the existing headset enrollment flow. On an empty registry, the normal server approval or explicit development bootstrap setting still applies.

1. Enter AR with no online helper. The world-anchored card shows **Pair a helper device** and the server's `/pair` addresses, with localhost first.
2. On the laptop, open the displayed address. `/pair` immediately displays a large QR and short code.
3. Look at the QR, or choose **Type code** in the headset. The camera checks twice per second in either mode, without a pairing timeout.
4. When the companion connects, the headset shows **Paired with <name>** for 1.5 seconds. The laptop shows **Paired with Quest 3**, followed by the existing USB/synth steps.
5. Reloading or revisiting `/pair` keeps the laptop's saved identity. **Skip for now** hides headset onboarding until the next AR session; choosing **Pair** on a tagged laptop reopens it.

`GET /api/helper` provides the URL order and helper presence. The same first URL supplies the laptop Control hint. An online companion makes a detected laptop eligible for setup when the existing local executor is available; pairing alone does not run setup or control commands.

Run `npm run e2e:judge` and `npm run e2e:flows` outside the coding sandbox. The judge's connected simulated room counts as its helper. Flow phases 06–06c check missing-helper onboarding, server URL text, Skip, typed-code success, QR decoding and the visible companion confirmation. Phase 18 checks reload and `/pair` revisit without another pairing request. Screenshots are written to `research/screens/v2-flows/`, including `06b-companion-pair-page.png` and `18-companion-pair-revisited.png`.

Sandbox validation: workspace typecheck and Quest/companion builds pass. The unit suite excluding four socket-dependent files passes. The full suite's socket cases fail with `listen EPERM`; the root build's schema-generation commands are also blocked because the `tsx` CLI creates an IPC socket. E2E and screenshot rendering were not run here.
