# Live demo acceptance

The primary acceptance target is **real Quest → live Muse setup → camera-verified Mac visual synth → accepted hand mapping → visible effect → Stop**. This guide is a test procedure, not a claim that the run has passed. The virtual instrument is an intentional, disclosed demo target; successful control does not establish arbitrary hardware support.

## Prepare the run

1. Keep the current Mac silent and IR disabled. Use one app server and one visible visual-synth renderer; stop build watchers, fixture browsers and headset live sharing when they are unnecessary. A live sharing tab does not stop its capture process when closed.
2. Confirm `/api/health` reports live mode and the Mac companion is paired to the real Quest. Never expose the API key in footage or logs. Keep the companion's **Details** available for source/evidence inspection.
3. Leave the paired Mac companion visible, with visuals closed. **Try visual synth** in Quest must automatically open its in-page Mac renderer. Do not manually pre-open it for this acceptance check. An emulator or prerecorded laptop image does not count as the real-display check.
4. On the Quest launcher, prepare **Camera + mic** if using Ask Muse. Refresh the app before the test while AR is inactive. Confirm the wearer can see the Mac display clearly and that both hands are tracked.
5. For the continuous proof, use the Quest's compositor capture so the AR controls and passthrough are both visible. Inspect a short test clip before the full run; capture behavior depends on the headset/browser version. A Mac screen capture can show the selected renderer and companion evidence, with sound disabled. Keep the uncut originals.

The app's **Record take** is an optional second artifact for Motion lab: it records passthrough video and pose telemetry, **not the rendered AR interface**, and stops after 90 seconds or a memory limit. A live setup can exceed 90 seconds, so that take is not a substitute for the full compositor recording. Start a separate short tracking take after setup if needed. Do not run the ffmpeg live-debug mirror merely to record a demo; it adds Mac load and retains no history.

## One continuous acceptance pass

| Step | Wearer action | Required observation |
|---|---|---|
| Select | Enter AR, open **ControlAnything Menu → Try visual synth**. | Mac visuals open automatically. The selected card names **ControlAnything Visual Synth**, not the saved MacBook playback controls. |
| Set up | Center the Mac display in the guide and choose **Set up control**. | Connection, research, command generation, effect checks and interface generation progress visibly. Record the time from the click to completion. |
| Verify | Keep the display in view during checks. | The actual Mac renderer changes and the selected device's camera evidence reports a pass. A command acknowledgement alone is insufficient. |
| Inspect source | Inspect the setup workspace/Details before enabling. | Driver and interface sources match the actual run; a live server setting alone is insufficient if a template or reused setup was returned. |
| Enable | Choose **Enable controls**. | Verification and human enablement remain distinct; only the verified controls become usable. |
| Map | Open **Ask Muse**, say “Make forward and backward movement of my right hand create water ripples,” and send. | The full request addresses the selected virtual synth. Muse proposes **Push/pull → Water ripples** before applying it. This maps an existing effect; it is not newly generated shader code. |
| Apply | Read the proposal and choose **Apply mapping → Use controls → Perform**. | The accepted mapping is visible. Use controls closes the completed Muse reply and returns to the device controls. Hand movement alone before Perform does not count as engagement. |
| Perform | Hold the left fist and slowly push/pull the right hand about 20cm. Try height-only movement and a head turn, then release the fist. | The Mac changes to a blue water surface with visible expanding ripples. Height-only movement and head turns do not substitute for depth; releasing the fist pauses control. Keep hands and screen visible in the continuous footage. |
| Recover | Stop Perform first, then raise an open left hand and hold briefly to recall Menu. Pinch and hold the wide **Move panel** bar, move it, then release. Lower/close the left hand before another recall. | Distant hand-ray dragging works without reaching the panel. Head motion does not move the placed menu. During Perform or an active Muse conversation, passive recall does not interrupt the task; explicit Menu remains available. Record wearer comfort separately from coordinate checks. |
| Stop and exit | Open both palms to stop, then use **Menu → Exit AR**. | The control stops, the visuals return to their expected stopped/default state, and exiting AR is reachable. |

If a step fails, retain the failure and mark the run incomplete. Retry as a new run with its own start time. Speed-up or edits in a short presentation must be labeled; the retained source clip should make waiting time and failures auditable.

## Source labels and evidence

Read the actual source facts for **both commands and interface**, not just the most recent stage's badge:

- `Live · <model>`: a live result for that stage. Match it to the same run's `/api/muse/calls` record.
- `Fixture` or `Fixture · recorded from <model>`: stored/canned model output. Keep this label visible; a historical model name does not make the current call live.
- `Curated template · no model generation`: device commands or UI came from a template. A successful effect check does not change that provenance.
- `Reused knowledge` / `Reused setup · original driver and interface`: accepted prior work was reused. Show this as a reuse demonstration rather than newly generated code.
- `Recorded demo · no device commands`: companion replay, not an execution against the current display.

Retain the selected target/card ID, driver ID, driver and UI source/model fields, relevant setup steps, `verify.result` evidence, command/ack timestamps, and the uncut recording. Endpoint summaries are available through `/api/agent/targets`, `/api/agent/steps`, `/api/agent/exec` and `/api/muse/calls`. Save only the relevant run; avoid including authentication envelopes, microphone PCM or unrelated room frames in a presentation artifact.

Record three separate durations: **Set up control → verification complete**, **Set up control → interface ready for Enable**, and **Enable → first deliberate visible gesture effect**. Report the measured run, mode and hardware. Do not present a 5–15 second component-model measurement or fast fixture run as total live setup time.

## Optional follow-ups after the device pass

**Selection and recovery:** While using the synth, pinch near its foreground controls with the MacBook on the same sightline. The active object must remain the synth. Use Menu → More tools → Change device to release it deliberately. Close visuals with Back to companion and choose Try visual synth again: it must reopen automatically. A hidden/offline companion must show an honest recovery instruction. Recovery never starts setup, Enable or Perform automatically.

**Inspect:** Choose a tagged book/object, then About this object. Read the overview and Details pages, including sources and excerpts when available. Unknown dimensions/weight/price must remain Unknown; a book title alone does not establish its ISBN/edition. A supplied-model catalog match is not an independent identification of the physical object. Inspect must neither start device setup nor create a game. Fixture mode explicitly reports that no live lookup occurred. This is the useful information path for ordinary objects; the choice game below remains optional.

**Reuse:** Repeat the same accepted request for the same unchanged action contract. A fresh Apply preview is expected, but mapping/planning calls should be avoided when exact reuse is valid. Count relevant model calls before/after; speech transcription may still run. Keep the reuse label visible.

**Generated shape:** Ask Muse to make the selected control a knob or lever and show the before/after card in the same take, then use the edited control. The stable card supports horizontal sliders, clockwise angular knob input and vertical lever input. The current Visual Synth contract has Warp and Water ripples plus up to three pattern buttons. A changed JSON specification alone does not prove the wearer sees a different shape; arbitrary meshes and ring/XY layouts are outside this accepted subset.

**Book Canvas:** In Find devices choose All, select a real visible book and verify its label, then Use devices → select its card → Make a game → preview → Play. Speak a small change such as “make this game harder,” inspect the new preview and play it. A manually inserted book fixture establishes UI flow only, not real book recognition. The game should not claim knowledge of unread pages. Device setup and Canvas are separate paths.

On Mac Home, check that setup and Devices remain primary and **Object games → Open Canvas** is below them. A newly started game should open its Canvas contextually; after **Hide Canvas**, ordinary status updates should respect that choice.

**Motion lab:** Record a short Quest take with both hands and a head turn, deliberately move one hand out of view, then exit AR and Save take. Open the ZIP in Mac Motion lab. Verify that the video decodes, hand/head movement aligns approximately, missing tracking remains missing, and export retains timestamps, sources and reference-space boundaries. The synthetic sample proves the viewer only. Camera-to-head calibration, robot retargeting and training effectiveness remain separate work.

## Physical instrument follow-up

The user confirmed on November 3 that the connected instrument is an **OP-1 Field** and expects to be available for a headset test shortly. No further original-OP-1-versus-Field question is needed for this instrument. Firmware and physical action acceptance remain pending.

1. Use the confirmed **OP-1 Field** identity. Record its firmware/settings and the applicable incoming MIDI implementation source and supported parameter; do not infer firmware or successful control from the USB port name.
   If it is mislabeled as a typing keyboard, stop controls and tell Ask Muse “This is actually an OP-1 Field.” Review the full identity proposal and choose Confirm identity. One connected OP-1 MIDI output corroborates the family only. Check that both Quest and Mac remove the old controls while preserving the selected object's placement. This action must not send an instrument command or automatically start setup.
2. Confirm the selected tag, connection and port refer to that instrument. Keep physical tests pending until the wearer explicitly resumes the hardware test and its output/verification method is agreed; Mac silence and disabled IR remain the current setup.
3. Use only a documented, reversible parameter and permitted range. A manually supplied chart is reference data, not proof of a connected device's identity or response. Importing it must not send commands or arm controls.
4. Show that a supported CC passes static eligibility while an absent CC remains rejected, then run the normal explicit setup/effect verification for the connected instrument. A port discovery or MIDI acknowledgement cannot substitute for an observed physical effect.
5. Enable the verified action and demonstrate one bounded change plus a return to baseline. Retain the exact model, firmware, chart source, parameter, channel/range and observed response. Broader protocols, moving-object tracking and physical IR follow this first accepted target.

## Acceptance record

For each run, record: date; app/build revision; headset/browser version; server mode; selected target; actual driver/interface source; clip path; timing values; effect evidence; menu/selection/hand feedback; Stop/exit outcome; pass/fail and unresolved issues.

Current release evidence is recorded in [the November 4 feedback ledger](../research/reviews/2026-11-04-visual-synth-acceptance.md). Earlier headset runs demonstrated height-to-Warp control but rejected menu and Canvas usability. Those successes do not accept the new depth-to-water flow. The real-headset/real-display run, physical OP-1 Field effect, and real Motion lab capture remain pending until separately observed.
