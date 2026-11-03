# Gesture performance

Open an armed, connected device card in Control and select **Perform**. Hold a left fist for 45 ms to engage; raise the right hand for the first parameter and roll the right wrist for the second. Opening the left hand freezes values immediately. Re-engaging captures a comfortable new reference and continues from the held values. Missing tracking also freezes. Both open palms facing away from the head for 120 ms use the existing Stop path and disarm controls.

With controllers, Perform is the clutch toggle. A tracked right grip supplies height and roll; the other grip supplies span. Turn Perform off before changing input sources. Hand pinches cannot select widgets while live. Using an ordinary control after releasing the fist exits Perform.

The vocabulary is fist, open palm, point and pinch, with independent entry dwell and release hysteresis. Axes are right-hand height, wrist roll, thumb/index aperture and two-hand distance. One Euro filtering, quantization and change detection cap each axis at 30 Hz. Feedback uses one instanced mesh and two text labels; only numeric text is refreshed at 5 Hz.

Forge publishes `ui.spec.gestureMap` after checking the current driver's verification record. Each binding names an action, range, curve, quantization, smoothing and rate. Unverified actions, unavailable step dependencies and actions needing hold confirmation are rejected. Names and declared ranges determine defaults; MIDI controller numbers remain solely in the verified driver.

| Device | Height | Roll | Aperture / span | Postures while engaged |
| --- | --- | --- | --- | --- |
| Visual synth | Warp | Zoom | Hue / effect mix if available | None by default |
| MIDI synth | Cutoff, filter or timbre | Supported pitch-bend CC or resonance | Resonance / reverb or effect mix | None by default |
| IR lamp | Brightness steps, at most 2 Hz | — | — | Pinch on, fist off, point brighter, open palm dimmer, where verified |
| Mac | Volume, at most 10 Hz | — | — | Pinch play/pause, point next, fist previous, where verified |

Only matching, verified actions appear. This implementation does not introduce a new MIDI message type or play notes. A posture already held when the clutch engages is ignored until it changes. IR composites take at most one physical step per changed gesture event; they leave no step sequence running after release. The router and dispatcher drop rate-limited gesture writes instead of delaying them.

`session.test.ts` drives synthetic joints through the engine to protocol `control.event`; `app/selection.test.ts` also exercises the actual app selection/connection gate. Server gesture-route and gesture-queue tests verify execution, re-verification, throttling and absence of trailing commands without sockets.

`npm run e2e:judge` (on an unused `PORT`) drives the golden path through Perform and both-palms Stop. To check a verified visual synth by hand: Perform → left fist → right height/roll → mapped control events; open left hand → no more events; disconnect or deselect → no events; both outward palms → Stop. The tests can use the synthetic fixtures if IWER cannot express all finger joints.

On Quest 3, check comfortable fist recognition and wrist-roll direction first. Confirm the LIVE badge and `Live · via Mac (USB MIDI)` route appear together, releasing the left hand holds the visual value while lowering the right arm, and re-engaging does not jump. Check Stop and tracking loss next, then inspect frame rate and draw calls with the meters visible. Keep the demo silent.
