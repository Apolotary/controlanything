# Sim room (`apps/sim`)

A virtual room that stands in for the hardware, so the whole ControlAnything loop runs from the repo: a desk with a
**laptop** whose screen runs the **visual synth** (the golden path), a photo-real Japanese LED **ceiling light**
with its **IR remote**, and a **synth** that takes the same MIDI CC numbers as a Teenage Engineering OP-1 Field. The
sim pairs with the server like any other client and plays several roles at once: the paired Mac (visual-synth
renderer), IR executor, MIDI executor, camera and audio sensor. The server, the agent and the Meta model calls are
exactly the same as with real devices; only the transport is simulated.

## Judge path: the whole demo without hardware

```sh
npm install
cp .env.example .env     # optional: put MODEL_API_KEY in .env for live Meta models.
                         # Without a key the server runs in FIXTURE mode and replays recorded real responses.
npm run demo:sim         # builds missing apps; sound on after the first browser gesture
# Add -- --fixture to force recorded/scripted replies; -- --mute is for unattended checks.
```

1. Open [the sim room](http://localhost:8787/sim/) first. It pairs automatically on localhost and acts as your Mac.
2. Open [the desktop Quest emulator](http://localhost:8787/quest/?emulate=1&camera=sim&mic=0) and choose **Enter AR**. Click = pinch, right-drag = look.
3. Tag the laptop's box in Annotate, then deliberately choose **Control**. Ask Muse to make an instrument for the visual synth. Watch the connector/code stream, then use the generated keys, XY surface or controls.
4. Choose **Stop** or press `X` to retire the connector. If a requested hand program needs screen calibration, follow its two-corner guidance; the emulator does not substitute mouse clicks for real screen contact.

For a simpler touch/webcam route without emulated hands, open [the reviewer demo](http://localhost:8787/quest/reviewer.html). Its instruments use the same Muse agent path. No-key runs are visibly **FIXTURE**, not live recognition/generation.

The light and OP-1-style synth remain protocol twins for other checks. Historical setup-first scripts require `CE_AGENT=0`; they are not the default flow.

```sh
node scripts/e2e-muse-agent.mjs   # current agent golden path, own muted fixture server
node scripts/e2e-reviewer.mjs     # phone/webcam, Buddy and isolated browser instruments
PORT=8796 npm run e2e:judge      # older compatibility flow, own muted fixture server
```

These checks require installed Chrome and use explicit fixture detections. They do not measure real SAM detector accuracy, headset comfort or physical device output. Screenshots stay under the private `research/screens/` directory.

`npm run demo:sim -- --fixture` forces fixture mode; `-- --live` forces live calls; `-- --open` opens the pages; `-- --mute` silences unattended playback. Existing served builds are reused; `-- --build` is refused while a live server is using them.

### Replay a recorded real session

Recorded headset takes (`apps/quest/public/takes/<take>/session.jsonl` + `frames/*.jpg`) replay through the live
pipeline: open `http://localhost:8787/sim/?take=<take>` and press PLAY. The sim re-sends what the headset sent at
the recorded times, answers the server's sensor requests with the recorded frames and audio, and compares what
comes back with what came back during the recording.

## What is simulated, and how honestly

| Real | Sim | Kept honest by |
|---|---|---|
| KOIZUMI LED ceiling light (remote KRH-TG-9A), IR | Rendered room + lamp state machine: off / on / night light (常夜灯), 10 dimmer steps (×1.4 each, 4.8–100 %), 5 colour steps 2700 / 3200 / 3800 / 4800 / 6500 K, CH1/CH2, ~1.5 s fades | The lamp obeys only its own **synthetic** code set `SIM-KZ` (AEHA frames with a made-up customer code `CE 51`), never the real KOIZUMI codes (none are public; the real flow learns them). Any other brand's code is decoded and ignored, and the log says so. Once real codes are captured, `apps/server/data/devices/koizumi-krh-tg-9a.learned.json` makes the sim obey exactly those. |
| Cardputer IR transmitter | Virtual IR LED: decodes the raw µs timings the server sends (NEC / AEHA by leader ratio, like a real receiver) | `exec.ack` only says the IR went out, never whether the lamp reacted: that is for the camera to find out. |
| IR receiver for learning | Virtual remote; presses during a learn window come back as raw timings with receiver-like distortion (marks stretched, spaces shrunk) | The server decodes them with its own codec. |
| Quest passthrough camera | 1280×960 frames at a fixed pose with the Quest 3 camera intrinsics (fx = fy = 868.3 px), fixed exposure and white balance, sensor noise, JPEG | Frames are developed from the lamp's actual (fading) state. |
| OP-1 Field over USB-MIDI | Web Audio synth with the OP-1 Field's incoming CC numbers: 46–49 engine (cutoff, resonance, detune, drive), 50–53 envelope, 54–57 FX (delay time, feedback, chorus, mix), 58–61 LFO, 7/9/10 mixer, 90–92 EQ, 64 sustain, 123 all notes off | CCs outside the chart (e.g. CC 20, the audio check's negative control) change nothing. The MIDI identity reply uses the MMA **non-commercial** ID `7D`, so it never claims to be a TE device. |
| Synth's USB audio into the Mac | Audio features (RMS, centroid, octave bands, log spectrum) straight from the synth's analyser | Same feature recipe as the companion's input. |

## How it works

- **The room** is a procedural Blender scene (`scene/room.py`, primitives and procedural materials only), rendered
  once with Cycles into linear **light layers**: the dusk window light, the lamp's LEDs and the night LED. Light adds
  linearly, so the browser rebuilds any lamp state per frame: `sky + level · colour(T) · lamp + night · amber · nightLED`,
  then a filmic curve, sRGB, sensor noise and JPEG (`src/room/compose.ts`). Layers ship as gzipped planar RGBE
  (`public/room/*/*.cel.gz`, 3.6 MB), with poses, intrinsics and exact device outlines from an id-mask render in
  `public/room/meta.json`.
- **Protocol**: device kind `sim`, capabilities `ir, midi, camera, mic, speaker, display`, ports
  `CE Sim Synth (OP-1 Field CC map)` and `CE Sim IR`. Handles `exec.command` (MIDI cc/note/pc/identity/panic, IR raw
  or NEC/AEHA bytes) → `exec.ack`; `sense.request` `frame` / `audio-features` / `ir-capture` → `sense.result`; sends
  `scan.frame` at ≤ 1 Hz and draws the `scan.result` outlines.
- **Several sim pages** share one lamp: one page (a Web Lock) is the paired device, the others mirror it.
  `/sim/?embed=room` is a bare canvas for the headset emulator (`window.ceSim` = canvas + device layout).

## Checks

Measured on Nov 2: SAM 3.1 with the prompt `ceiling light` on a sim frame of the **unlit** lamp returned one
detection at IoU 0.98 with the render's exact outline (confidence 0.76, 5.0 s). The server's camera oracle reads
every lamp transition the right way (on/off, night light, each dimmer step, each colour step, and "no change" for
a code the lamp ignores), and the audio oracle sees a CC 46 sweep (spectral centroid ×2.5) but not CC 20.

```sh
npm test                                              # codec, code table, lamp, camera development, HDR codec
npx tsx apps/sim/scripts/oracle-check.ts              # the server's camera oracle on sim frames: all 34 lamp transitions
npx tsx apps/sim/scripts/sam-check.ts --state off     # ONE live SAM 3.1 call: does it see the (unlit) ceiling light?
npx tsx apps/sim/scripts/loop-check.ts                # end to end through the real hub: open :8899/sim/, click once
```

Re-render the room (Blender 5.x, ~15 min on an M1 Pro):
`Blender -b -P apps/sim/scene/room.py -- --out /tmp/room --samples 320`, then
`npx tsx apps/sim/scripts/pack-room.ts --src /tmp/room`.
