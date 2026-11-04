# Camera, phone and mobile WebXR demo

Open **`/quest/reviewer.html`** on the same ControlAnything server. It works with touch or a mouse and does not need a Quest, USB device, Web MIDI permission, or a separate companion tab.

For a local laptop:

```sh
npm install
npm run build                 # only when a live session is not using dist
MODEL_MODE=fixture CE_DEMO=1 npm start
```

Visit [the camera demo](http://localhost:8787/quest/reviewer.html). Without an API key the server returns clearly labelled **FIXTURE** recordings/scripted connector output; these are examples, not live recognition or generation. To use Muse Spark live, configure `MODEL_API_KEY` in your private `.env` and start the normal server. Never put a key into the webpage or URL. Keep sound on for the demo; `?mute=1` is available for unattended browser checks.

## Meet Buddy

1. Choose **Wave hello**, **Pet Buddy**, or **High five**. The same animated 3D Buddy used on Quest reacts immediately, with procedural sound and OS/browser speech.
2. Choose **Use camera**. On a phone it prefers the rear camera; on a laptop it prefers the webcam. **Switch camera** changes that preference. No microphone is requested. The preview is unmirrored so it matches the uploaded photo.
3. Aim at an object and choose **Capture object**. The full visible video image freezes. Inspect it before sending it: **Retake** discards this local still; **Show Buddy** sends exactly that JPEG to the connected server for Muse Spark to react to.
4. **Virtual object** cycles through locally drawn plant, water-orb and mini-synth illustrations. Press **Show Buddy** to share one. The request explicitly identifies it as virtual; it is not represented as a camera sighting or AI-generated object.
5. **Camera off**, hiding the page, or leaving the page stops camera tracks. Hiding the page also cancels pending reactions and clears the local preview. Returning does not restart the camera automatically.

Buddy has no scavenger quests, scores, or win conditions in the current experience. On Quest, the matching flow is **Buddy → Capture → review the photo → Show Buddy**; **Retake**, **Virtual**, and **Wave hello** are on Buddy's card. Hands draw its attention and can pet its head or meet its hand for a high five; they never automatically take or upload a photo.

## Ask Muse for an instrument

1. Choose **Water visuals** or **Musical synth**, then **Connect demo**. On localhost the server may approve this demo automatically. On a phone, approve its displayed controls pairing code on the owner's Mac companion. That approved controller then authorizes its own same-page software executor. They have separate identities; neither reuses your actual headset or Mac identity.
2. Keep the page visible. The instrument engine is authored software; the controls are not playable until you ask Muse to write the connector.
3. Choose **Ask Muse to build it**. The default request asks for touch controls. Muse writes, deploys and tests its connector on the server; its source and progress appear below. Live requests call only Meta models. Fixture runs remain visibly labelled.
4. Use Muse's generated keys, XY surface, toggles or parameter controls. Buttons beside parameter sliders provide tap alternatives to dragging. The browser renders the real visual-synth state or measures the software audio graph after the connector's commands. The receipt distinguishes a sent value from an applied browser command.
5. Choose **Stop Muse** to cancel generation or retire the current connector and silence its held note. Changing instrument, hiding the page or disconnecting clears the old controls; ask again to start a new interaction.

The reviewer executor advertises only its two exact browser software outputs. Its virtual device cards are scoped to that executor. It requests no physical-device permissions and refuses hardware commands. The server also binds virtual connector routing to the selected software card, rather than choosing an unrelated Mac output.

## Native mobile AR

On a device/browser that reports native `immersive-ar` support, **Place Buddy in AR** requests a real WebXR AR session with a DOM overlay for touch controls. Buddy is placed in front of the initial view; it is not described as a detected surface or persistent spatial anchor. **Exit AR** returns to the page. The camera demo remains available if this session cannot start.

WebXR and camera access need a secure context. For a phone on the same trusted network, use the server's HTTPS address and a certificate that the phone trusts; plain HTTP to a LAN IP is not a secure camera context. A certificate-warning bypass alone may not satisfy every mobile browser. The page explains camera denial, missing cameras and insecure connections and still offers virtual objects. [MDN's secure-context guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) and the [WebXR DOM Overlay specification](https://immersive-web.github.io/dom-overlays/) describe these browser requirements.

Feature detection controls what the page offers; it never installs an XR emulator on a phone. Browsers without native AR, including browsers on iPhone that do not expose it, use an inline camera and touch experience. This fallback has **no headset hand tracking, calibrated passthrough projection, surface detection, or real-world anchoring**. In native AR, virtual objects and generated touch controls remain available; exit AR for the explicit camera-photo flow because mobile XR camera access is not assumed.

## Verification

`node scripts/e2e-reviewer.mjs` starts its own muted fixture server on port 8801, with isolated data and a staged Quest bundle supplied by `CE_QUEST_DIST`. It checks the real browser camera API with Chromium's synthetic video input, preview/retake/upload boundaries, Buddy virtual reactions, two Muse instrument connector paths, Stop, and mobile layout. It also checks the Quest Buddy preview flow in the emulator. These checks do not establish real iPhone/Android camera quality, native mobile AR support, physical webcam quality, or real Quest comfort; those remain device acceptance checks.
