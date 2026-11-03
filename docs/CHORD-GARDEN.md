# Chord Garden demo

Chord Garden is a small, authored browser instrument with four large AR chord pads. A deliberate point-and-pinch plays a short chord on the Mac. It is inspired by the one-note-to-chord idea of [Telepathic Instruments' Orchid](https://support.telepathicinstruments.com/hc/en-us/articles/16643623307791-How-to-play-a-chord-on-Orchid), not an Orchid replica or a live Muse-generated instrument.

## Start the demo

1. In the paired Mac browser, open **Muse Canvas** at `/companion/canvas/` and choose **Try Chord Garden**. On later visits, select the saved Chord Garden project.
2. Choose **Run preview**, then **Enable sound**. Sound stays off until that explicit click. Keep this page visible; **Expand webpage** gives the instrument more room.
3. In Quest AR, choose **Menu → Muse Canvas**. If another project appears, use **Next project** until the title reads **Chord Garden**.
4. Choose **Enable pads**. Point at a chord, pinch once, then release. One hand or a controller is sufficient; this instrument does not use the visual-synth demo's left-fist clutch.
5. Try **Cmaj7 → Am7 → Fmaj7 → G7**. The Mac displays the chord and notes; the AR panel reports the last triggered chord.
6. **Stop** in AR ends pad control and sends silence. **Mute** on the Mac disables audio and makes the AR pads unavailable. Re-enabling sound does not automatically re-enable pads.

The full instrument can also be played with its browser buttons. The first version has four fixed chords and short envelopes; sustained notes, strumming, key changes and arbitrary hand-generated melodies are later features. Use **New** to create a different webpage with Muse; this built-in instrument does not pretend its fixed sound engine was generated on demand.

## Behavior and limits

| Pad | Notes | Voicing |
| --- | --- | --- |
| Cmaj7 | C4, E4, G4, B4 | C major seventh |
| Am7 | A3, C4, E4, G4 | A minor seventh |
| Fmaj7 | F3, A3, C4, E4 | F major seventh |
| G7 | G3, B3, D4, F4 | G dominant seventh |

The trusted Mac host synthesizes four quiet triangle-wave voices per chord, each ending within 0.82 seconds. A new chord replaces the previous one. Stale counter snapshots, reloads and reconnects do not replay old notes. No MIDI or physical-instrument command is sent; OP-1 Field is a separate future output path.

Mac Stop, hidden page, lost connection, project/revision changes, loss of write access, project errors or an audio interruption disable the instrument. Quest Stop, navigation, XR exit and loss of all tracked pointing sources disarm pads. A dropped network cannot sustain a stuck note because every voice has a bounded lifetime. After recovery, audio/pads require the relevant explicit enable steps again.

## Implementation boundary

- An explicit owner-only `project.preset` request creates a saved `ProjectDocument` with `source: 'preset'` and `presetId: 'chord-garden-v1'`.
- Its sandboxed HTML/CSS/JS provides visuals and the ordinary validated action bridge. It has no audio or hardware capability. Generated Canvas projects keep their existing restrictions.
- The trusted host recognizes the exact preset provenance before allowing sound. Editing through ordinary project generation removes preset eligibility. A matching title or action name alone is insufficient.
- The host advertises the preset's preview lease only while the current sandbox is ready **and** sound is explicitly enabled. Quest requires one current preview, active AR and an explicit pad-enable action.
- Pad events use the existing foreground selection/capture system and revision-bound `project.action` messages. They do not add a second gesture dispatcher or restore the distracting hand skeleton.

## Validation

Unit coverage exercises pitches/envelopes, bounded polyphony, baseline suppression, Stop, failed/interrupted unlock, provenance, owner authorization, revision changes, actual HUD capture and pad lifecycle. The dedicated `npm run e2e:chords` walkthrough uses a separate fixture server and headless Chrome with `--mute-audio`; its screenshots and receipt are written to `research/screens/chords/`.

Muted browser checks can establish Web Audio scheduling, shared events and UI behavior. They cannot establish the perceived sound, actual headset reach or tracking comfort. The attended acceptance is one uncoached four-chord progression, then Stop, mute/re-enable and a repeat, with no unintended target or navigation changes. The current run results are recorded in `HANDOFF.md`.
