# Sim room (`apps/sim`)

A virtual room that stands in for the hardware, so the whole ControlEverything loop runs from the repo: a
photo-real Japanese LED **ceiling light** with its **IR remote**, and a **synth** that takes the same MIDI CC
numbers as a Teenage Engineering OP-1 Field. The sim pairs with the server like any other client and plays four
roles at once: IR executor, MIDI executor, camera and audio sensor. The server, the agent and the Meta model calls
are exactly the same as with real devices; only the transport is simulated.

## Judge path: the whole demo without hardware

```sh
npm install
cp .env.example .env     # optional: put MODEL_API_KEY in .env for live Meta models.
                         # Without a key the server runs in FIXTURE mode and replays recorded real responses.
npm run demo:sim         # builds what is missing, starts the server, prints the URLs below
```

1. **Open the sim room: <http://localhost:8787/sim/>** and click once anywhere (browsers only allow audio after a
   click). It pairs itself (the page is on localhost, which the server trusts) and shows `PAIRED · ONLINE`.
2. **Open the headset app: <http://localhost:8787/quest/>** (desktop emulation of the Quest 3; it shows the sim room
   as its passthrough view).
3. **Scan and link the light.** SCAN sends camera frames to the server; SAM 3.1 outlines the ceiling light and
   Muse Spark identifies it. To link it, the agent sends IR codes from the sim's virtual IR LED while the camera
   watches. Codes from other brands do nothing (the honest miss: `sent ✓ · seen ✗`), so the agent asks you to
   **press the highlighted button on the virtual remote**; the sim captures that press like an IR receiver,
   the agent replays the learned code, the camera sees the room get brighter (`seen ✓`), and the generated
   controls arm after your one-tap confirmation. Move them and the light in the room changes.
4. **The synth.** The synth answers the agent's MIDI identity request, plays the notes it sends, and every CC
   it gets changes the sound and the synth's screen. The audio check reads the synth's own output.

Without the headset page you can still drive everything from the sim page: **SCAN 1 HZ** streams frames to the
server, the **AGENT** panel shows each step with the Meta model that ran it, and the **WHAT THE SIM SEES AND DOES**
log shows every IR frame the lamp received (and whether it obeyed), every MIDI message and every sensor reading.
Model calls with ids, latency and tokens are listed at <http://localhost:8787/api/muse/calls>.

`npm run demo:sim -- --fixture` forces fixture mode; `-- --live` forces live calls; `-- --open` opens the pages.

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
