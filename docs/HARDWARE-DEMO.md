# OP-1 Field: attended hardware demo

This is the next acceptance pass after the Mac touch-water demo. The software can identify a MIDI target, ask Muse for its driver, verify an effect and then ask Muse for live hand wiring. A detected USB port or successful MIDI send does not establish that the physical instrument responded.

## Three-step check with the wearer present

1. **Confirm the instrument and one parameter.** Connect the user's **OP-1 Field** by USB-C to the paired Chrome companion and enable MIDI there. Confirm the Field model and firmware on the instrument, and select its actual output rather than the virtual Visual Synth. The stored broad CC reference requires firmware **1.7.0 or later**; Teenage Engineering's changelog identifies that release as adding MIDI controls. Keep speakers muted unless the present user explicitly chooses sound. Do not update firmware during a take. [Official firmware notes](https://teenage.engineering/downloads/op-1/field).

2. **Review a small chart and let Muse write.** Tag the instrument in Annotate, select it in Control, and choose Set up control after reviewing its incoming MIDI chart in **Mac Details → Reviewed MIDI chart**. Use the exact displayed maker/model and the instrument's configured MIDI channel. A conservative first parameter is **CC50, synth-envelope attack**, with a reviewed demo range such as **16–64**; record a baseline value in that interval to restore afterward. The manufacturer's reference documents CC50 as attack with the full supported range 0–127. The smaller interval is our rehearsal recommendation, not a different manufacturer limit. Supply repeated notes yourself during an agreed audio-verification session; attack changes are heard on new notes, not a continuously held note. Choose Enable only after the physical effect passes. Then ask Muse, for example, “Use my right hand height to change the envelope attack, and return to the agreed baseline when my hand disappears.” Watch the live code and its validation before trying it. [Official incoming MIDI reference](https://teenage.engineering/guides/op-1#midi-reference), [chart workflow](MIDI-CHARTS.md).

3. **Demonstrate, restore and Stop.** Move one hand slowly through the comfortable range and observe the intended parameter and sound envelope. Retain the generated driver/wiring, exact CC/channel/range, measured output and the instrument response in the same take. Restore the agreed baseline while controls are available, then Stop with both palms or the wrist menu. Do not assume Stop or All Notes Off restores patch parameters: the device does not provide a reliable current-value readback here. A failed effect check is an incomplete hardware demo; preserve the failure and use the accepted Mac demo for the submission.

## Choosing a filter instead

Do not call generic engine **CC46** “filter cutoff”: its meaning changes with the selected engine. The official reference calls CC54–57 patch-FX parameters 1–4. A filter demo is appropriate only after the performer selects a specific filter effect, confirms which on-device parameter that CC changes, records its baseline and reviews a bounded chart for that setup. This is an attended follow-up, not a pre-wired filter mapping. [Official MIDI reference](https://teenage.engineering/guides/op-1#midi-reference).

Exclude patch randomize/reset, tape record/play, program changes and generated note triggers from this first reviewed CC-only subset. A reviewed chart grants only its listed CC/channel/range. Muse writes the glue after the wearer asks; the transport, signal sampling and sandbox are application infrastructure.

## Current verification boundary

- Read-only CoreMIDI enumeration on November 4 found **no MIDI sources, no destinations and no IAC bus**. No loopback test was possible without changing system settings; no physical packets, notes or sound were sent.
- Existing automated MIDI chart, identity/peripheral and companion-executor tests establish software permissions and encoding with test doubles. They do not establish OP-1 behavior.
- Newly tagged, unarmed-device selection is implemented and software verified: Annotate → Control can select the intended device for setup instead of requiring an already-armed Mac. The focused selection checks passed (41 tests); physical Quest acceptance remains pending.
- If SAM calls the instrument a typing keyboard, prepare microphone access before AR, select that tagged object in Control and choose **Correct device** on its unarmed, nonvisual card. Say “This is actually an OP-1 Field,” send, review the proposal and choose **Confirm identity**. The default entry is implemented and its HUD regression passed; no lab URL is required. Confirmation changes identity and clears old controls without starting hardware control. WIRE requires a controllable device and cannot substitute for this pre-setup review. Do not silently proceed with the wrong identity.
- Firmware/settings, actual MIDI endpoint selection, physical effect, Stop behavior and the continuous hardware take remain pending the wearer pass.

## Developing the connector on the Mac

Mac **Details → Connector Workshop** runs native Muse Code with real project-file and terminal tools. A request such as “Debug the OP-1 Field USB-MIDI bridge; inspect routing and check it without sending MIDI” creates a retained task branch and patch. Ordinary hand-mapping requests still use the smaller gesture harness. Review actual file changes and terminal results before applying a patch; coding completion does not prove that the connected instrument responded.

Muse Code authored the ambiguous-output fix in `midiExec.ts`: duplicate exact names and ambiguous partial names are refused instead of picking the first endpoint. Native and independent focused checks each passed sixteen tests with fake MIDI I/O. This is a verified software correction; the attended OP-1 Field check above is still required.
