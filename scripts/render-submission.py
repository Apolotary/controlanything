#!/usr/bin/env python3
"""Render the local, evidence-labeled submission storyboard; never plays audio.

Requires Pillow, macOS `say`, ffmpeg and ffprobe. Run from any directory:
  python scripts/render-submission.py [--encode]
Sources/outputs live in the ignored research/video directory. No browser,
network, model, device, microphone or camera access is used.
"""
import argparse
import hashlib
import json
import re
import subprocess
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'research/video'
OUT = WORK / 'output'
FRAMES = OUT / 'frames'
AUDIO = OUT / 'audio'
SIZE = (1280, 720)
BG = '#101917'
INK = '#eef5ee'
MUTED = '#b2c4bb'
ACCENT = '#b5ecc9'
BORDER = '#344b40'
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
MONO = '/System/Library/Fonts/Menlo.ttc'


def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def font(size, bold=False, mono=False):
    return ImageFont.truetype(MONO if mono else BOLD if bold else FONT, size)


def lines(text, face, width):
    result = []
    for paragraph in text.split('\n'):
        row = ''
        for word in paragraph.split():
            trial = f'{row} {word}'.strip()
            if row and face.getlength(trial) > width:
                result.append(row)
                row = word
            else:
                row = trial
        result.append(row)
    return result


def write(draw, xy, text, size=26, width=350, fill=INK, bold=False, gap=8):
    f = font(size, bold)
    x, y = xy
    for row in lines(text, f, width):
        draw.text((x, y), row, fill=fill, font=f)
        y += size + gap
    return y


def shot(scene, duration, title, body, asset=None, crop=None, label=None, kind='image', detail=None):
    return dict(scene=scene, duration=duration, title=title, body=body, asset=asset,
                crop=crop, label=label, kind=kind, detail=detail)


def shots():
    v = 'research/screens/voice/'
    # Crops only enlarge existing pixels; no invented UI or generated response animation.
    hud = [480, 140, 1440, 740]
    return [
        shot(0, 12, 'Control\nAnything', 'An object. A request.\nAn interface you can inspect.',
             v+'08c-perform-with-tracked-hands.png', hud, kind='title'),
        shot(1, 8, 'Choose the\nright target', 'A visual instrument has its own controls.',
             v+'03-choose-virtual-instrument.png', [150, 350, 1110, 950]),
        shot(1, 10, 'Ask for the\ninteraction', '“Map right-hand height to Warp.”',
             v+'05b-combined-voice-request.png', hud),
        shot(2, 10, 'See the work\nas it happens', 'Connect · Learn · Write\nCheck · Build · Enable',
             v+'05c-muse-builds-controls.png', hud),
        shot(2, 8, 'Inspect the\ncommands', 'Separate recorded OP-1 example. Structured data and its source.',
             v+'10-companion-generated-driver.png', [438, 572, 1222, 958],
             'SEPARATE OP-1 INSPECTOR DEMO · NO DEVICE COMMANDS'),
        shot(2, 7, 'Inspect the\ninterface', 'Separate recorded OP-1 example. A bounded control definition.',
             v+'10b-companion-generated-interface.png', [438, 572, 1222, 958],
             'SEPARATE OP-1 INSPECTOR DEMO · NO DEVICE COMMANDS'),
        shot(3, 11, 'Check the\nresponse', 'A sent command is only the beginning.',
             v+'06-camera-verifies.png', [540, 290, 940, 570]),
        shot(3, 9, 'You choose\nwhen to enable', 'The walkthrough exercises the verification gate.',
             v+'07-enable-controls.png', hud),
        shot(4, 7, 'Review the\nproposal', 'Right-hand height → Warp\nLeft fist → clutch',
             v+'08-review-gesture-proposal.png', hud),
        shot(4, 7, 'Apply, then\nperform', 'Accept the mapping before it affects the instrument.',
             v+'08a-apply-verified-mapping.png', hud),
        shot(4, 9, 'A gesture\nchanges the visual', 'Automated hand inputs changed the rendered synth output.',
             v+'08c-perform-with-tracked-hands.png', hud),
        shot(4, 5, 'Stop is\nalways explicit', 'Reset the performance and return to a neutral state.',
             v+'09-stop-resets.png', hud),
        shot(5, 9, 'Remember the\ninteraction', 'Reuse the accepted mapping. Review and apply it again.',
             v+'08b-reuse-saved-mapping.png', [160, 340, 870, 720]),
        shot(5, 6, 'A reusable\nmapping', 'The repeated request adds no planning or mapping calls.',
             kind='reuse'),
        shot(6, 8, 'Separate\nlive-model evidence', 'Historical trace · simulated target\nNot current headset footage', kind='trace'),
        shot(6, 7, 'Muse authored\na book game', 'A generic blue-cover prompt.\nPreview only; no book was read.', kind='game'),
        shot(7, 6, 'No connection?\nCreate an interaction.', 'Canvas offers an editable choice game inspired by an object.',
             'research/screens/canvas/04-mac-edit.png', [455, 640, 1204, 912]),
        shot(7, 6, 'Preview. Play.\nRevise.', 'Shared game state between Quest and the Mac companion.',
             'research/screens/canvas/03-shared-play.png', [550, 230, 930, 660]),
        shot(8, 8, 'Movement,\nin context.', 'Hand joints · Head pose\nTimeline · Gaps · Export',
             'research/screens/tracking/02-synthetic-sample.png', [45, 270, 1395, 1000]),
        shot(8, 7, 'Inspect the\ntracked pose', 'Synthetic sample. Real capture alignment and training value need evaluation.',
             'research/screens/tracking/02-synthetic-sample.png', [840, 445, 1240, 780]),
        shot(9, 10, 'Observe. Ask.\nInspect. Interact.', 'Next: a continuous headset take, then one verified OP-1 Field effect.', kind='close'),
    ]


def base(index, item, scene, start):
    im = Image.new('RGB', SIZE, BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((40, 32, 81, 73), 12, fill=ACCENT)
    d.text((48, 41), 'ca', fill=BG, font=font(22, True))
    d.text((97, 42), 'ControlAnything', font=font(23, True), fill=INK)
    d.text((665, 46), 'NARRATED STORYBOARD  /  SYNTHETIC VOICE', font=font(16, True), fill=MUTED)
    d.line((40, 95, 1240, 95), fill=BORDER, width=1)
    label = item.get('label') or scene['label']
    label_size = 16 if len(label) > 65 else 18
    d.text((40, 116), label, font=font(label_size, True), fill=ACCENT)
    d.text((40, 176), f'{item["scene"]+1:02d} / 10', font=font(16), fill=MUTED)
    y = write(d, (40, 218), item['title'], 38 if item['kind'] != 'title' else 48,
              350, bold=True, gap=10)
    write(d, (40, y+25), item['body'], 23, 340, fill=MUTED, gap=10)
    d.text((40, 629), 'REVIEW CUT · APP SCREENS + SAVED EVIDENCE', font=font(14, True), fill=MUTED)
    d.text((1108, 629), f'{int(start)//60}:{int(start)%60:02d} / 2:50', font=font(17), fill=MUTED)
    d.line((40, 669, 1240, 669), fill=BORDER, width=3)
    d.line((40, 669, 40+int(1200*(start+item['duration'])/170), 669), fill=ACCENT, width=3)
    return im


def panel(im, item):
    d = ImageDraw.Draw(im)
    box = (416, 172, 1240, 598)
    d.rounded_rectangle(box, 18, fill='#172820', outline=BORDER, width=1)
    if item['asset']:
        source = Image.open(ROOT/item['asset']).convert('RGB')
        if item['crop']:
            source = source.crop(tuple(item['crop']))
        source = ImageOps.contain(source, (800, 402), Image.Resampling.LANCZOS)
        im.paste(source, (428+(800-source.width)//2, 184+(402-source.height)//2))
        return
    x, y = 452, 206
    if item['kind'] == 'reuse':
        evidence = json.loads((ROOT/'research/screens/voice/reuse-check.json').read_text())
        before, after = evidence['planningAndMappingCallsBefore'], evidence['planningAndMappingCallsAfter']
        write(d, (x, y), 'PLANNING + MAPPING CALLS', 18, 720, fill=ACCENT, bold=True)
        d.text((x, y+56), f'{before} → {after}', font=font(86, True), fill=INK)
        write(d, (x, y+170), 'Same saved gesture map.\nExplicit review and Apply still required.', 26, 720)
        write(d, (x, y+286), 'Source: reuse-check.json · automated fixture run', 17, 720, fill=MUTED)
    elif item['kind'] == 'trace':
        # Verify the fields used on the evidence card, rather than trusting prose.
        records = [json.loads(line) for line in (ROOT/'apps/quest/public/takes/take-2026-11-02T02-45-47/session.jsonl').read_text().splitlines()]
        phases = set()
        for record in records:
            payload = record.get('msg', {}).get('payload', {})
            if payload.get('source') == 'live' and payload.get('model') == 'muse-spark-1.3' and payload.get('status') == 'ok':
                phases.add(payload.get('phase'))
        assert {'drive', 'forge'} <= phases, phases
        write(d, (x, y), 'SAVED TRACE · NOVEMBER 2', 18, 720, fill=ACCENT, bold=True)
        for i, line in enumerate(['server: live', 'model: muse-spark-1.3', 'drive: ok  /  source: live', 'forge: ok  /  source: live']):
            d.text((x, y+51+i*45), line, font=font(23, mono=True), fill=INK)
        write(d, (x, y+257), 'Desktop emulator · synthetic camera\nSimulated target · no physical IR proof', 21, 720, fill=MUTED)
    elif item['kind'] == 'game':
        game = json.loads((ROOT/'research/screens/canvas/live-muse-game.json').read_text())
        doc = game['document']
        assert doc['source'] == 'live' and game['game']['phase'] == 'preview'
        write(d, (x, y), f"SAVED LIVE RESULT · {doc['modelId']}", 18, 720, fill=ACCENT, bold=True)
        y = write(d, (x, y+53), doc['spec']['title'], 32, 710, bold=True)
        y = write(d, (x, y+23), doc['spec']['rounds'][0]['prompt'], 25, 710)
        write(d, (x, y+26), '2 original rounds · schema-valid · preview only', 21, 710, fill=MUTED)
    else:
        write(d, (x, y), 'READY FOR THE NEXT RECORDING', 18, 720, fill=ACCENT, bold=True)
        write(d, (x, y+62), '01   Live Quest → Muse → Mac visual\n02   Comfortable fingertip controls\n03   One observed OP-1 Field action', 29, 720, gap=27)
        write(d, (x, 535), 'Headset acceptance and physical effects remain pending.', 19, 720, fill=MUTED)


def stamp(seconds):
    ms = round(seconds*1000)
    return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'


def narration(scenes):
    pcm = []
    captions = []
    timing = []
    count = 1
    for scene in scenes:
        ident, spoken = scene['id'], scene['narration']
        source = AUDIO/f'{ident}.txt'
        aiff, wav = AUDIO/f'{ident}.aiff', AUDIO/f'{ident}.wav'
        signature = hashlib.sha256((spoken+'|Samantha|165').encode()).hexdigest()
        sigfile = AUDIO/f'{ident}.sha256'
        if not wav.exists() or not sigfile.exists() or sigfile.read_text() != signature:
            source.write_text(spoken)
            # FILE OUTPUT ONLY: this invocation cannot speak through the speakers.
            run(['say', '-v', 'Samantha', '-r', '165', '-f', str(source), '-o', str(aiff)])
            run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-threads', '1', '-i', str(aiff),
                 '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', str(wav)])
            sigfile.write_text(signature)
        with wave.open(str(wav), 'rb') as audio:
            assert audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getframerate() == 44100
            raw = audio.readframes(audio.getnframes())
        duration = len(raw)/88200
        available = scene['duration']-0.7
        if duration > available:
            raise ValueError(f'{ident}: narration {duration:.2f}s exceeds {available:.2f}s. Trim text; do not truncate audio.')
        lead = b'\0'*(int(0.4*44100)*2)
        target = int(scene['duration']*44100)*2
        pcm.append(lead+raw+b'\0'*(target-len(lead)-len(raw)))
        # Draft caption timings are sentence-weighted; final wearer narration needs a new alignment pass.
        chunks = re.split(r'(?<=[.!?])\s+', spoken)
        total = sum(len(c) for c in chunks)
        cursor = scene['start']+0.4
        for chunk in chunks:
            end = cursor+duration*len(chunk)/total
            captions.append(f'{count}\n{stamp(cursor)} --> {stamp(end)}\n{chunk}\n')
            count += 1
            cursor = end
        timing.append(dict(id=ident, speech_seconds=round(duration, 3), scene_seconds=scene['duration']))
    with wave.open(str(OUT/'scratch-narration.wav'), 'wb') as audio:
        audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(pcm))
    (OUT/'captions.srt').write_text('\n'.join(captions))
    (OUT/'narration-timing.json').write_text(json.dumps(timing, indent=2)+'\n')
    print(json.dumps(timing, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--encode', action='store_true')
    args = parser.parse_args()
    for folder in [FRAMES, AUDIO]:
        folder.mkdir(parents=True, exist_ok=True)
    scenes = json.loads((WORK/'submission-script.json').read_text())
    items = shots()
    assert sum(s['duration'] for s in scenes) == sum(s['duration'] for s in items) == 170
    for i, scene in enumerate(scenes):
        assert sum(s['duration'] for s in items if s['scene'] == i) == scene['duration']
    manifest, images, start = ['ffconcat version 1.0'], [], 0
    for i, item in enumerate(items):
        im = base(i, item, scenes[item['scene']], start)
        panel(im, item)
        path = FRAMES/f'{i+1:02d}.png'
        im.save(path)
        images.append(im)
        manifest.extend([f"file 'frames/{path.name}'", f"duration {item['duration']}"])
        item['start'] = start
        start += item['duration']
    manifest.append(f"file 'frames/{len(items):02d}.png'")
    (OUT/'frames.ffconcat').write_text('\n'.join(manifest)+'\n')
    (OUT/'edit-manifest.json').write_text(json.dumps(items, indent=2)+'\n')
    # Readable 4-column contact sheet for editorial QA without playing audio.
    sheet = Image.new('RGB', (1280, 180*((len(images)+3)//4)), BG)
    for i, im in enumerate(images):
        sheet.paste(im.resize((320, 180), Image.Resampling.LANCZOS), ((i%4)*320, (i//4)*180))
    sheet.save(OUT/'contact-sheet.jpg', quality=95)
    narration(scenes)
    if args.encode:
        run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '1',
             '-f', 'concat', '-safe', '0', '-i', str(OUT/'frames.ffconcat'),
             '-i', str(OUT/'scratch-narration.wav'), '-i', str(OUT/'captions.srt'),
             '-map', '0:v', '-map', '1:a', '-map', '2:s', '-t', '170',
             '-vf', 'fps=24,format=yuv420p', '-filter_threads', '1', '-c:v', 'libx264',
             '-preset', 'veryfast', '-crf', '21', '-threads', '2', '-c:a', 'aac', '-b:a', '128k',
             '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
             '-metadata', 'title=ControlAnything — narrated storyboard (synthetic voice)',
             '-movflags', '+faststart', str(OUT/'ControlAnything-review-cut.mp4')])
    print(f'Wrote {len(items)} cards, 170-second scratch narration and draft captions under {OUT}', flush=True)


if __name__ == '__main__':
    main()
