# Hands: signals (Muse writes the glue) and the old Perform

## Signals: what a wiring program can read

Nothing here maps a hand to a device. `signals.ts` only measures: every frame it turns WebXR joints into the `Signals` of `research/36-muse-wiring-contract.md`, and Muse's wiring program (`wiring/`, written live after the wearer asks, run in a Web Worker sandbox) decides what they mean. Until a `wire.ready` has arrived and is running, hands do nothing to any device.

| Signal | Meaning |
| --- | --- |
| `right`/`left`: `height`, `push`, `side` | palm position in the play zone (`SIGNAL_RANGE`): chest to above the head, pulled in to arm extended, left to right across the body. "Forward" is where the head has been looking (slow follow), so a glance never steers a value |
| `pinch`, `pinchTap` | thumb-index closeness 0..1 (relative to the hand's size); `pinchTap` is true for exactly one frame after a pinch shorter than 350 ms that moved the wrist < 5 cm and did not start on UI |
| `fist`, `open`, `palmOut`, `speed` | postures (the same detector as before), palm facing away from the head, wrist speed in m/s |
| `screen` | present once the selected device's screen is calibrated: the index fingertip nearest the plane gives `u`, `v` (0..1, top-left = 0,0), `distance` (m, >= 0 in front), `inside`, `touching` (< 2 cm, released at 3 cm), `hover` (1 at contact, 0 at 15 cm), `vu`, `vv`, `hand` |

Both palms out for 120 ms is the stop gesture (one pulse); it stops the wiring, and the program gets one last run with no hands so it can lift whatever it holds.

## Calibrating a screen

`screen-calibration.ts`: "touch the top-left corner", then "the bottom-right one". A fingertip held within 1.4 cm for 0.4 s near the device (above its centre for the first corner, right of and below the first for the second) counts. `screen-plane.ts` builds the plane from the two points: the horizontal edges stay horizontal, the lean (monitor 0 degrees, laptop lid up to 35 degrees back) is chosen to face the wearer's head at calibration, and both corners lie on the plane. The plane is stored per card in `localStorage` (`ce.screen-plane.v1.<cardId>`) and dropped if the device's anchor moved by more than 0.6 m. "Recalibrate screen" is in the device card.

## Old Perform (`?perform=1` only)

The hand-written mapping below (a `gestureMap` from `ui.spec`, clutch or play zone) is no longer offered or started by default: the wearer asks Muse for a wiring instead. It stays reachable with `?perform=1` for rehearsal and debugging.

---

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
