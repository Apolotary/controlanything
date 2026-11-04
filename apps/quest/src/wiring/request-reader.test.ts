import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import type { HudTarget, WirePhase, WireView } from '../hud/contract';
import { createHud } from '../hud/v2';
import { GlassSurfaces } from '../hud/v2/surface';
import { REQUEST_READING, requestReadingPages, WireRequestReader } from './request-reader';
import { UIKitReader } from '../hud/v2/uikit-reader';
import readerFont from '../../public/fonts/muse-reader-inter.json';

const request = Array.from({ length: 55 }, (_, i) => `word${i}`).join(' ');
const view = (phase: WirePhase = 'stopped', requestId = 'ask-1', text = request): WireView => ({
  targetId: 'mac', phase, prompt: 'Stopped · ask again', chips: ['Touch the water'], mic: 'idle',
  code: { requestId, wiringId: 'wire-1', request: text, phase, model: 'muse-spark-1.3', source: 'fixture', code: '', phaseLine: phase, mode: 'pill' },
});

describe('reading a wiring request without controlling the device', () => {
  it('retains every word across bounded pages, with Previous, Next and a return that stays stopped', () => {
    const surfaces = new GlassSurfaces(), reader = new WireRequestReader(surfaces);
    reader.set(view()); expect(reader.open()).toBe(true);
    expect(reader.previous.visible).toBe(false); expect(reader.next.visible).toBe(true);
    const pages = requestReadingPages(request), read: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(reader.reader.text).toBe(pages[i]); expect(reader.reader.text).not.toContain('…');
      read.push(reader.reader.text);
      if (i + 1 < pages.length) reader.nextPage();
    }
    expect(read.join(' ').split(/\s+/)).toEqual(request.split(' '));
    expect(reader.next.userData.disabled).toBe(true);
    expect(reader.next.visible).toBe(false); expect(reader.previous.visible).toBe(true);
    reader.previousPage(); expect(reader.reader.text).toBe(pages.at(-2));
    reader.close(); expect(reader.visible).toBe(false);
    expect(reader.canOpen).toBe(true); // Closing is presentation only, never resume.
    reader.disposeUi(); surfaces.dispose();
  });

  it('keeps requests in short, spacious chunks without changing other readers', () => {
    const longRequest = ('Play like a theremin. ' + Array.from({ length: 9 }, (_, i) =>
      `Part ${i + 1}: let hand height choose notes and pinch play them. `).join('')).slice(0, 465) + ' Last words stay visible.';
    expect(requestReadingPages(longRequest)).toHaveLength(3);
    const advances = new Map(readerFont.chars.map(g => [g.id, g.xadvance / readerFont.info.size]));
    for (const text of [longRequest, 'W'.repeat(500), '日本語の本'.repeat(100), '👩‍🚀'.repeat(90), 'Right hand → ripples, left hand → colour.']) {
      const pages = requestReadingPages(text);
      expect(pages.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
      for (const page of pages) {
        const lines = page.split('\n');
        expect(lines.length * REQUEST_READING.fontSizeMm * REQUEST_READING.lineHeight)
          .toBeLessThan((REQUEST_READING.contentHeight * 1000) - REQUEST_READING.paddingMm * 2);
        for (const line of lines) {
          const width = Array.from(line).reduce((sum, char) => sum + (advances.get(char.codePointAt(0)!) ?? 1.2) * REQUEST_READING.fontSizeMm, 0);
          expect(width).toBeLessThan(REQUEST_READING.contentWidth * 1000 - REQUEST_READING.paddingMm * 2);
        }
      }
    }
    const legacy = new UIKitReader();
    expect(legacy.layout.width).toBe(.38); expect(legacy.layout.height).toBe(.28);
    legacy.disposeUi();
  });

  it('opens only long stopped/failed requests and never opens an active program or short chip', () => {
    const surfaces = new GlassSurfaces(), reader = new WireRequestReader(surfaces);
    for (const phase of ['asked', 'writing', 'validating', 'dry-run', 'verifying', 'ready', 'calibrating', 'running'] as const) {
      reader.set(view(phase)); expect(reader.available).toBe(true); expect(reader.open()).toBe(false);
    }
    reader.set(view('failed')); expect(reader.open()).toBe(true);
    reader.set(view('stopped', 'short', 'Touch the water')); expect(reader.available).toBe(false); expect(reader.visible).toBe(false);
    reader.disposeUi(); surfaces.dispose();
  });

  it('preserves the page through same-epoch updates and closes on an identical new request or target change', () => {
    const surfaces = new GlassSurfaces(), reader = new WireRequestReader(surfaces);
    reader.set(view('failed')); reader.open(); reader.nextPage(); const page = reader.reader.text;
    reader.set({ ...view('failed'), code: { ...view('failed').code!, phaseLine: 'failure details updated' } });
    expect(reader.visible).toBe(true); expect(reader.reader.text).toBe(page);
    reader.set(view('failed', 'ask-2')); expect(reader.visible).toBe(false);
    reader.open(); reader.set({ ...view('failed', 'ask-2'), targetId: 'another-device' });
    expect(reader.visible).toBe(false);
    reader.open(); reader.set(null); expect(reader.visible).toBe(false);
    reader.disposeUi(); surfaces.dispose();
  });

  it('routes Read request locally, explains active phases and emits no Muse, control or navigation action', () => {
    const camera = new PerspectiveCamera(), hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
    const target: HudTarget = { id: 'mac', label: 'Visual synth', tagged: true, connection: 'ready', status: 'scanned',
      position: [0, 1.4, -1], facing: [0, 0, 1], confirmed: true };
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Ready' });
    hud.upsertTarget(target); hud.setLocked(target.id); hud.setDeviceState?.({ targetId: target.id, connection: 'ready', silentVisual: true });
    const spec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'verified', state: { armed: true } };
    hud.renderSpec(spec, { targetId: target.id }); hud.setArmed(spec.specId, true);
    const sent = vi.fn();
    for (const name of ['wireAsk', 'wireRecalibrate', 'assistantTalk', 'assistantDismiss', 'control', 'mode', 'setup'] as const) hud.on(name, sent);
    const actions = hud as unknown as { lookAction(id: string): void; widgets: { group: { name: string }; start(): void }[] };
    hud.setWire?.(view('writing')); actions.lookAction('wire-read-request');
    const reader = hud.root.getObjectByName('wire-request-reader') as WireRequestReader;
    expect(reader.visible).toBe(false); expect(hud.root.userData.wire.phase).toBe('writing');
    hud.setWire?.(view()); actions.lookAction('wire-read-request'); expect(reader.visible).toBe(true); expect(hud.isReadingRequest?.()).toBe(true);
    actions.widgets.find(w => w.group.name === 'wire-request-next')!.start();
    expect(reader.userData.reading.page).toBe(1);
    actions.widgets.find(w => w.group.name === 'wire-request-return')!.start();
    expect(reader.visible).toBe(false); expect(hud.isReadingRequest?.()).toBe(false); expect(hud.root.userData.wire.phase).toBe('stopped');
    expect(sent).not.toHaveBeenCalled();
    hud.dispose();
  });
});
