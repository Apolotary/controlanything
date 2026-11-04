# Muse-generated instruments

Select and tag an object in Annotate, deliberately choose Control, then ask Muse for an instrument. Muse Spark writes a connector, deploys and tests it, and returns a compact design. No instrument runs before that request. `MODEL_MODE=fixture` uses a clearly labelled scripted replay of the same tools.

The optional `finish.ui` composer accepts up to eight widgets: keys, pads, XY surface, knob, fader, wheel, dimmer ring, lever, button and toggle. Each binding must name an action on the running connector. Keys/pads either send one index/note to a set action or name individual trigger actions; an XY surface needs two set actions. Wheels use integer steps. Ranges must stay inside the connector's declared range. The trusted server compiler validates the resulting `ce.gen3d/1` geometry and sends it in `wire.ready.ui`; existing clients can use the fallback `controls` row.

The headset mounts the existing `SpecObject` renderer between the selected device and the wearer. Poke or press keys and pads; touch an XY surface or a fader track directly; pinch and twist encoders. Pinch dragging remains an alternative. Key targets include 44 mm black keys. The code card collapses when controls appear; code remains available in Details. Deliberate menu recall is suppressed while a control or XY touch is in use.

Live notes, ripple/pulse rings and four-second parameter ribbons reflect values actually sent by the headset's wiring controller, including Worker outputs. They are input feedback, not independent measurements of a speaker, screen or gimbal. A fixed pool and at most three draw calls handle the feedback; the rest of the instrument uses a compact rendering mode without layered bloom or decorative bracket meshes. Stop retires the connector and its controls.

The fixtures include OP-1-style encoders and an octave, the visual synth's water XY surface and three encoders, a browser musical synth using its declared CC16/17 note/gate contract, and connected mock-gimbal pan/tilt controls. The visual and musical synths remain explicit optional demos. No physical device is substituted for a software demo.

Validation:

- `CE_QUEST_DIST=/tmp/ce-stage-instruments node scripts/e2e-instruments.mjs` runs an isolated fixture server and verifies a mouse-driven key reaches the connector as an acknowledged MIDI note, a visual control sends CC21, a mock-gimbal control sends pan, the live feedback reacts, and Stop removes each connector.
- `scripts/e2e-muse-agent.mjs` also verifies Stop Muse during generation and handles both rich and fallback controls.
- One live `muse-spark-1.3` run produced and validated four coloured encoders plus keys and a note visualizer in 30.4 seconds, using a scratch software sink with no hardware or speech.
- The staged emulator scenes measured 112 draw calls for OP-1, 84 for the visual synth, and 56 for the mock gimbal; the feedback layer uses at most three.
- Screenshot and performance checks are from desktop emulation. Real Quest comfort, frame time and physical-device behavior of the new instrument UI still require wearer acceptance.
