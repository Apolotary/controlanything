# Reviewed MIDI charts

An unfamiliar instrument needs a trustworthy incoming-MIDI chart before Muse can generate parameter controls. Web research can find relevant sources, but its prose is not executable knowledge and does not add CCs to the allowlist.

In the Mac companion, open **Details → Reviewed MIDI chart**:

1. Select the tagged instrument in **MIDI chart instrument**. Confirm its maker, exact model and applicable firmware against the physical device. A generic `OP-1` port name does not establish OP-1 Field identity.
2. Enter the manual title, HTTPS source URL, page/section and MIDI channel.
3. Add one to twelve documented parameter rows: CC number, parameter name, minimum and maximum. Use the instrument's incoming-control reference, not a list of messages it only transmits.
4. Check the explicit instrument/manual review confirmation and choose **Save reviewed chart**.
5. Return to the Quest and retry setup. The model's generated commands must match the stored CC, channel and range. A physical effect still needs verification, then the wearer chooses Enable controls.

The chart is bound to the selected card, maker and model. Saving it does not start setup, send a MIDI message or arm anything. Changing identity invalidates applicability; edits use a revision check so an older form cannot silently overwrite a newer chart. A new revision invalidates existing controls, including saved versions restored after a restart; setup and effect verification must run again. Supported data is bounded to unique CCs 1–119, excluding bank-select CC 32, with channel 1–16 and parameter values within 0–127. The encoder preserves those reviewed wire-value bounds. Unlisted or out-of-range parameter operations remain rejected.

This first import grants incoming CC parameter permissions only, not note, program-change or SysEx permissions. For a later agreed audio-verification session, the performer supplies a sustained sound while the parameter is checked; importing a chart does not authorize generated test notes. The local store holds at most 64 instrument records.

“Reviewed” means the user explicitly checked the cited reference. It is not a claim that the server independently authenticated the manual, recognized the hardware perfectly, or measured an effect. Verification remains a separate stage.

## API

Read the current selected instrument's chart with `GET /api/agent/midi-charts/:cardId`. The response includes the card's displayed identity, current revision, and the reviewed record or `null`.

The explicit save request is `POST /api/agent/midi-charts`:

```json
{
  "cardId": "selected-instrument-card-id",
  "expectedRevision": 0,
  "reviewed": true,
  "chart": {
    "maker": "Exact maker from selected card",
    "model": "Exact model from selected card",
    "source": {
      "title": "Instrument MIDI implementation manual",
      "url": "https://manufacturer.example/manual",
      "section": "Incoming control changes, page 12"
    },
    "channel": 1,
    "parameters": [
      { "cc": 74, "name": "Example parameter", "min": 0, "max": 127 }
    ]
  }
}
```

The values above illustrate the request shape; they are not a chart for any actual device. Use the revision returned by GET and the real manual's parameters. The same permission boundary as other approval actions applies. The server stores reviewed records locally and retains citation and revision provenance in subsequent research.

## Acceptance

Automated checks can establish that a reviewed CC becomes eligible and an unsupported CC, mismatched identity/transport or out-of-range request remains rejected. Only the physical acceptance pass in [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md#physical-instrument-follow-up) establishes that the chosen instrument responds as expected. Stop at a clear missing-chart or unsupported-device result when a usable reference is absent; no local Mac-command fallback substitutes for MIDI.
