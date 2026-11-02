# Quest hand input verification

Open the deployed Quest page with `?debug=1`, enter AR, put down the controllers,
and hold both hands inside the headset's view. The small debug plate reports L/R
tracking, joint counts, thumb–index distance in cm, select event counts, frame rate,
and draw calls. A tracked index tip has a dot; pinching makes it brighter. Point at
a target to see its hover highlight, then pinch to select it.

1. Move each hand separately. Its dot must follow the index fingertip; a fully
   tracked hand normally has 25 joints. Bring thumb and index within 2 cm for two
   frames to pinch; separate them beyond 3.5 cm for two frames to release. The
   system select gesture can also pinch when joint poses are temporarily missing.
2. Turn the non-dominant palm upward and hold for at least 0.5 seconds. The deck
   should open above the wrist. Turning the back of the hand upward must not open it.
3. Move a hand outside the tracking area and bring it back. Its dot must disappear
   while its index pose is missing, then recover. Try a brief occlusion during a
   pinch; it must not create a fresh pinch or leave a permanently held selection.
4. Exit AR and enter it again. Repeat both hands' pinches and the palm gesture.
   Select counts must respond in the new session without duplicate events.

With the orchestrator's existing DevTools connection on localhost:9222, run these
from the repository root while the headset is in AR:

```sh
node scripts/quest-cdp.mjs --hands 4500
node scripts/quest-cdp.mjs --fps
```

Keep both hands visible and pinch several times during the 4.5-second sample.
Expect `handSources` and `jointHits` above zero, `errors: 0`, `minPinchM` below
`0.02` for a close pinch, and `select` above zero. Some `jointNulls` during tracking
loss are normal. Repeat after leaving and re-entering AR. Record the debug plate's
joint counts and select counts alongside the helper output if anything fails.

The helper samples joint poses inside a fresh XR animation callback. Inspect
`window.__ce.lastFrame` for already sampled data; do not invoke pose methods on its
stored XRFrame from the console, because WebXR frames are only active during their
callback. Sampling uses three.js's current reference space from the same session.
See the [WebXR frame lifecycle](https://www.w3.org/TR/webxr/#xrframe-interface) and
[three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html).
