# OP-1 Field and DJI OM 4: attended demo

The default flow is **tag in Annotate → Control → Ask Muse → watch code/deployment/tests → interact → Stop**. Connect the real device first; no Set up / Enable press is required before asking. Those gates belong to the optional older `CE_AGENT=0` route.

## OP-1 Field

1. Connect the instrument by USB to the paired Mac companion in Chrome. Enable Web MIDI and confirm its actual output name and configured channel. Input and output may both be named OP-1; this is normal.
2. Enable **MIDI receive on the instrument itself**. Tonight's notes/CCs only arrived after the user enabled it. The field note is **shift + COM → MIDI**, from user/forum guidance, not an official menu-path claim; use the settings appropriate to the actual unit/firmware. The [manufacturer reference](https://teenage.engineering/guides/op-1#midi-reference) describes messages, and [firmware notes](https://teenage.engineering/downloads/op-1/field) describe version-specific support.
3. Tag/select the OP-1, correct its identity if needed and ask Muse for the desired interaction. Muse should use actual connected output names and documented capabilities, write/deploy/test the connector, then return the requested controls. Start with short notes and a conservative parameter range. Generic engine CCs are not universally filter cutoff: confirm the selected engine/effect before naming a parameter.
4. Observe both the physical parameter and sound. Restore any agreed parameter baseline, then Stop. All Notes Off does not restore a patch parameter. Keep the instrument's hardware volume available alongside the app master control.

Reported tonight: the real Quest sent notes and CCs to the physical OP-1 after receive was enabled. This does not establish every engine/CC, the new generated instrument layout or every firmware version. The older [reviewed-chart workflow](MIDI-CHARTS.md) remains relevant when explicitly using that lane.

## DJI OM 4

Use **Bluetooth**. USB-C supplies power; it is not the control connection. Start the live Mac server with `CE_DEMO=1 CE_OSMO=web npm start`, with sound on and no `CE_MAC_SILENT`. In Chrome open the local Osmo link page on **:8799**, choose the OM 4 and keep that tab alive. It holds the Web Bluetooth connection. A stale pairing may need to be forgotten and paired again. Agent-shell BLE scans lack macOS Bluetooth permission; that is not a broken gimbal.

With the wearer present, tag/select the gimbal and ask Muse for small pan/tilt controls. The connector uses `gimbal.pan`, `gimbal.tilt`, `nudge`, `recenter` and `stop`. The bridge clamps pan ±120°, tilt ±45°, roll ±30°, slew ≤90°/s and ≤10 sends/s; begin a rehearsal within ±15° and leave mechanical clearance. Stop holds the estimated aim.

Small direct Bluetooth pan/tilt/recenter commands worked tonight. **Muse-driven gimbal control has not yet been verified end to end on physical hardware.** Its attitude packet layout is unconfirmed. “Gimbal confirmed the command” means a successful correlated rotate answer, not a measured reached angle. Watch the actual device. Never interpret the old decoded −103° tilt as a reliable measurement.

## Software-only development

Use `CE_OSMO=mock` and a private fixture directory/port for automation; never use :8787/:8443/:8799. The mock decodes the same rotation packets and reports explicitly simulated positions. Fake MIDI and emulator receipts establish software behavior, not sound or movement on a device.

The Mac **Details → Muse connectors** panel exposes current process/actions/logs and Stop. **Connector Workshop** is a separate patch-review development tool, not the default runtime hand-mapping lane. Do not stop/restart the live server, reload the headset in AR or replace live dist while the wearer is testing.
