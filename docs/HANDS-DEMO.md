# AR without a headset: webcam and phone

Open **`/quest/hands.html`** on the ControlAnything server, for example `http://localhost:8787/quest/hands.html` on the Mac that runs it. Phones need HTTPS for the camera: use `https://<mac>:8443/quest/hands.html` with a certificate the phone trusts. The Quest entry page links here. `reviewer.html` now opens this page too; add `?buddy=1` for its Buddy-first flow.

The page follows the Quest's golden path, AR view first.

1. **Start AR** is the only tap before the AR view; the camera permission needs it. What you get depends on the device:
   - **Android Chrome** opens a WebXR `immersive-ar` session, with the camera passthrough and the page in a DOM overlay.
   - **iPhone Safari** has no WebXR AR, and the page says so. It uses the rear camera full screen as the passthrough.
   - **A laptop** shows the mirrored webcam full screen.
2. **Annotate** comes first. The page sends camera frames to the server as `scan.frame`, the same path the Quest uses, so SAM 3.1 is the only detector. Filters: Electronics · Objects · All. The outlines come back in the Quest's look.
   - **Phone:** tap an outline to tag it.
   - **Webcam:** hold your hand over an outline until the ring fills, close your hand on it, or click it.

   You stay in Annotate. In WebXR AR, a tag is anchored in the room with a hit test, so it stays on the object as the phone moves.
3. **Control** is a deliberate switch at the top. Select a tagged device to open its card, then ask Muse in one of two ways:
   - **A chip.** The Quest's own text: `LAPTOP_WIRE_CHIPS` for a laptop or Mac, `PHYSICAL_WIRE_CHIPS` for anything else.
   - **Voice.** Hold the mic and speak; Muse Voice Transcribe turns it into text.
4. **Muse writes the glue.** The same Muse agent `wire.request` runs, and the code card streams beside the device. **Stop Muse** cancels it at any point, even mid-generation.
5. **Controls** appear pinned to the device: beside its SAM box on a webcam, at its hit-test anchor in WebXR AR. A hand program runs in the Quest's sandboxed Worker on the same `Signals` as on the Quest. Webcam hands supply them (classic computer vision, below), or touch does on a phone.
6. **More** holds the optional demos, as on the Quest: the visual synth and musical synth hosted on this page, and Buddy. It also has hand calibration, the tracking mask, a camera switch, hand sounds and Stop all.

The **Now** panel shows the Quest wrist dashboard's rows (Layer · Object · Devices · Muse) and the Next step. Tutorial bubbles follow the Quest's steps. Sounds start after the first tap and follow one master volume:
- the Quest's UI cues and browser speech;
- the page's procedural hand sounds;
- the instruments, once Muse wires them.

## Webcam hand tracking (no AI model)

Webcam hand tracking is **classic computer vision**, run in a Worker at about 192 × 144 pixels. No model of any kind is loaded or called. It works in these steps:

- **Skin colour.** A Mahalanobis distance in the YCrCb colour space against a skin model. **Calibrate** refits the model to your palm and your light.
- **Background.** A webcam does not move, so every pixel that stays unchanged for about 4 s becomes background. Skin only counts where the image differs from it. Warm walls, wood and a still face drop out this way.
- **Face.** It is found once and followed with mean shift, then masked out.
- **Hands.** Connected components give the two hands. Each hand is the top of its blob down to the wrist. Open versus closed comes from the hand's fill, outline compactness and height-to-width ratio.
- **Smoothing and identity.** One Euro smoothing; left and right follow the mirrored view.

Muse's programs get the Quest's `Signals` shape, so they run unchanged:

| Signal | Webcam meaning | Quality |
|---|---|---|
| `height`, `side` | the hand's place in view | good |
| `speed` | roughly m/s at arm's length | good |
| `push` | apparent hand size against the calibrated palm (closer = bigger) | approximate |
| `pinch`, `fist`, `open`, `pinchTap` | how closed the hand is (a fist reads as a pinch) | approximate |
| `palmOut` | not measured: always `false`, so there is no two-palms stop (use Stop Muse or Esc) | none |
| `screen` | there is no calibrated screen: always `null` | none |

On a phone, a touching finger is a hand, and touching reads as a closed hand.

**Limits.** Expect it to struggle with:

- the first ~4 s, before the background is learned;
- coloured or dim light;
- hands in front of the face;
- touching hands, which merge into one blob;
- a hand held perfectly still, which fades until it moves.

## WebXR AR on Android

SAM needs camera frames inside the AR session. The page asks for WebXR raw camera access (`camera-access`) and reads a small copy of the AR camera image for each scan. If the browser does not offer it, the page says so and the camera view is the way to annotate. Webcam hand tracking does not run in AR; touch drives the hands there.

## Verification

`CE_QUEST_DIST=<staged bundle> research/e2e-lock.sh node scripts/e2e-hands-parity.mjs` starts its own FIXTURE server on port 8796 and the sim Mac. The fake camera is the sim room image with synthetic hands drawn over it, so the FIXTURE SAM outlines are its ground truth. The check walks the golden path on a laptop, and on a phone in both the camera view and emulated WebXR (IWER). It writes `research/screens/2026-11-05-hands-parity/verification.json` and screenshots. It does **not** establish:

- tracking on a real webcam or real skin;
- real phones or native Android AR (including `camera-access`);
- a live Muse run.
