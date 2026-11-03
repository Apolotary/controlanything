# Muse Canvas web projects

Muse Canvas generates a self-contained HTML/CSS/JavaScript application with shared software controls. The full webpage can run in the **Quest browser itself** or on the Mac. A native AR panel can drive another open preview with hand gestures, or render a supported generated spatial recipe directly in the headset. This is separate from the older object-inspired choice games.

## Create and use a webpage in the headset

1. In AR choose **Menu → Muse Canvas**. With no saved webpage, the panel explains the first step and offers **Create webpage**. With an existing project, choose **Open webpage in headset**.
2. This deliberately exits immersive AR, stops active hand-control inputs and opens the Canvas studio in the same headset browser tab. It reuses the headset's paired identity; no Mac page or additional pairing is needed when the headset is already connected.
3. Describe an idea using the browser keyboard, or choose an example. Choose **Generate with Muse**. The complete request remains in the editor and the status says when Muse is writing or when the saved page is ready.
4. Review the page source or declared controls, then choose **Run preview**. Generation does not execute the page automatically. **Expand webpage** gives the full interface most of the browser window; **Show editor** restores editing.
5. Use the browser's pointer and pinch or controller to click the generated webpage or its sliders. **WebXR hand-position gestures are paused outside AR.** Normal browser interaction is the fallback, not a claim of simultaneous immersive hand tracking.
6. **Return to AR** stops the flat preview and returns to the Quest launcher with the selected project preserved. Enter AR deliberately. The project and current shared values remain saved. An AR panel can control another running preview, for example on the Mac; the flat headset preview does not remain visible behind immersive AR.

The local headset studio route is `/companion/canvas/?headset=1`. An optional `project` selects a saved page; an optional `prompt` prefills up to 4,000 characters without submitting or running it. Return navigation is fixed to `/quest/` with a `canvasProject` selection. Tokens and generated source are never placed in these URLs. Emulated Quest sessions reuse `ce.device.quest` without borrowing the Mac's identity.

## Generate a native AR visual

A generated project can now include a validated `spatial` recipe: an **orb** or **ripple rings**, a color, and a binding to one of its declared numeric controls. These are trusted, bounded Three.js components; generated JavaScript is never evaluated inside the AR scene. This is a first structured AR Canvas slice, not arbitrary HTML or shaders in immersive AR.

1. On the headset or Mac Canvas webpage, ask Muse for an orb or ripple-ring visual with a numeric intensity control and a native AR preview.
2. Generate and review the result. Return to AR on Quest and open that project in **Muse Canvas**.
3. Choose **Run AR preview**. The visual appears inside the shared workspace; no Mac preview is required for this native route.
4. Choose **Start hand control**, hold the left fist and raise/lower the right hand. Canonical values change the orb size or ring radii. This is height input, not depth sensing or a water simulation.
5. **Stop hand control** stops inputs. **Stop AR preview** hides the native visual. Navigation, hidden XR, disconnect or a changed revision require an explicit restart. The full webpage remains available through **Open webpage in headset**.

The optional recipe is part of Muse's generated project output and keeps its actual live/fixture provenance. It does not turn the separately authored Chord Garden preset into live-generated music, add audio, or connect physical devices.

## Use AR gestures with a Mac preview

1. Open **Muse Canvas** from the paired Mac companion, or visit `/companion/canvas/` in that browser.
2. Generate a webpage and explicitly choose **Run preview**. The provenance label distinguishes live Muse output from fixture samples.
3. Keep exactly one preview visible on Mac. In Quest, enter AR and choose **Menu → Muse Canvas**. Select the project and numeric control. Wait for **Preview connected**, then choose **Start hand control**. With no preview or multiple previews, the panel explains what needs to change.
4. Hold the left fist and raise/lower the right hand. Release the fist to pause; open both palms after engaging to stop. **Stop hand control**, navigation and leaving AR also stop inputs. Trigger controls use **Run action**.
5. Use **Stop** in the browser to remove the running preview. Editing, changing projects, disconnecting or hiding the studio also stops the preview and AR inputs. Runtime errors stop it too. After **Run preview** restores the connection, choose **Start hand control** again; a held fist cannot restart it automatically.

Project source, current revision and shared numeric values persist locally. Generated application variables outside the shared action interface are not automatically persisted. Editing currently saves the latest revision; a previous-revision browser is not included.

## How control reaches the page

Each project declares up to eight actions. Numeric actions declare a finite minimum, maximum and initial value; trigger actions increment a counter. Web controls and Quest gestures send the same `project.action` messages. The server validates the project revision, action identity and range, then distributes authoritative values and a sequence number. Quest hand inputs are limited to 15 Hz and stop on lost tracking, navigation, session exit, disconnect or revision changes.

Preview presence begins after the sandbox acknowledges startup for the current project/revision. A lightweight lease belongs to that exact browser connection; closing one rendering tab removes its lease even when another tab uses the same paired identity. The server expires a silent lease after five seconds, checked once per second. AR actions for a webpage require exactly one current preview. A valid native spatial preview explicitly started in the current Quest workspace can instead drive its declared software input without a Mac lease; revision/action/range validation still applies. This acknowledgement establishes a running browser runtime, not visual correctness or a physical effect.

Generated code can call `window.museCanvas.emit(actionId, value)` and subscribe with `window.museCanvas.subscribe(values => { /* render */ })`. Subscriptions receive initial values immediately. Code should render from subscriptions and emit only in response to interaction, avoiding feedback loops. `window.museCanvas.state` exposes current values.

The webpage executes inside an opaque-origin, scripts-only sandbox. A content security policy restricts resources and requests; active markup, ordinary links and form navigation are removed. The host checks frame source, nonce, project and revision before forwarding an action. Generated code receives no companion token, device API or hardware execution permission. The server stores source as data and never evaluates it. These browser boundaries do not provide a hard CPU quota for generated JavaScript.

## Current boundaries

- Create/edit prompts are entered in the studio on Quest or Mac. Spoken creation through Ask Muse is not integrated yet.
- Arbitrary HTML is not embedded inside immersive AR. A full generated page uses the headset's flat browser; entering/leaving AR is explicit.
- Preview acknowledgement cannot prove that generated graphics satisfy the request. Observe the result on the chosen display.
- The current custom AR numeric gesture is right-hand height with a left-fist clutch. Depth movement and arbitrary new gesture sensing are not provided by generating webpage code.
- The bridge controls software state only. Connecting a generated app to physical hardware remains a separate capability and permission integration.
- Generated apps are self-contained: external packages, remote assets, audio, cameras and account integrations are outside this version.
- Physical-object movement as an input and robot-training accuracy remain separate work.

## Validation

`npm run e2e:projects` uses an isolated silent fixture server on **8803/8453**, a sandboxed browser preview and IWER Quest emulation. It covers generation, explicit Run, origin isolation, shared actions, stale revisions, reload, preview readiness/loss/explicit restart, AR hand input, a generated native recipe with no Mac preview, and the headset's full-page route, generation and return. It never calls a live model or physical instrument. Evidence is saved under `research/screens/projects/`; actual Quest comfort and live Muse output need wearer acceptance.
