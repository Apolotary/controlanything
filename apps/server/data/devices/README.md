# Curated device data

Reference data the agent's RESEARCH step reads before asking a model anything: MIDI implementation
charts and infrared code libraries, one JSON file per device or device class. The loop uses them as
**allowlists** (a generated driver may only use CC numbers and IR codes that appear here or were learned
from the device's own remote) and as the factual brief in the model prompts.

## Provenance

Every file was compiled during the hackathon (Nov 2, 2026) from public sources, and every entry carries
a `sources` list with URLs and a confidence label:

- `docs`: the manufacturer's own guide, manual or release notes (facts, not copyrighted expression).
- `community`: blogs, forum posts, GitHub projects, Qiita articles that measured or decoded the codes.
- `inferred`: derived here (bit reversal, parity rules, channel formulas); treat as a hypothesis until the
  camera or the device confirms it.
- `unknown`: no public data was found.

| File | Covers | Main sources |
|---|---|---|
| `op-1-field.json` | Teenage Engineering OP-1 Field incoming CC chart (fw >= 1.7.0) | TE OP-1 field guide v1.7.0 "midi reference"; community device tests |
| `ep-133.json` | TE EP-133 K.O. II MIDI (OS 2.5), identity reply | TE EP-133 guide (system, what's new) |
| `ableton-move.json` | Ableton Move MIDI (2.1.1): notes/clock only, ignores CC | Ableton help centre, release notes |
| `kastle-2.json` | Bastl Kastle 2 Wave Bard USB-MIDI CC map | Bastl manual v1.5, MIDI cheat sheet |
| `jp-ceiling-light-ir.json` | NEC / AEHA code tables for Japanese LED ceiling lights (Panasonic, NEC Lighting, Toshiba, Hitachi, Takizumi...) | Community decodes (mamezou, hello-ino, katsumin, shrkn65, SmartIR, Flipper-IRDB), chip datasheets for the formats |
| `koizumi-krh-tg-9a.json` | KOIZUMI KRH-TG-9A remote: no public codes exist; the codes are **learned** from the remote with an IR receiver | Retailer listings, universal-remote compatibility lists |

## Licences

- Manufacturer documentation is quoted as facts (CC numbers, timings), not reproduced.
- Community code tables are facts measured by their authors; each is cited by URL. Flipper-IRDB entries are
  CC0; SmartIR codes are MIT; midi.guide (pencilresearch/midi) is CC-BY-SA-4.0 and is cited where it was used.
- The JSON files themselves are part of this repository and carry its licence.

Learned codes (recorded from the user's own remote during a session) are written next to these files as
`<device>.learned.json` with the capture timings, the label the camera oracle assigned and the evidence.
