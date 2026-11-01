import { readdirSync, readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { CallLog } from '../muse/callLog';
import { type DecodedImage, decodeJpeg, encodeJpeg } from '../oracle/image';
import { iou, pointInPolygon, polygonBox, polygonFor, simplifyPolygon, traceOutline } from './polygon';
import { findQr, parsePairingQr } from './qr';
import { cannedSamText, decodeMask, FixtureSam, frameHash, parseSamText, samKey, simCannedRecords } from './sam';

describe('SAM output grammar', () => {
  it('parses boxes, confidences and one_bit masks; empty text is zero matches', () => {
    const text = '<0f>0<|box;x1=16;y1=279;x2=669;y2=671;w=1280;h=853;c=0.9649|><|mask;x=0;y=0;c=0.9649;data=393,654,!abc~def|>,3<|box;x1=1;y1=2;x2=3;y2=4;w=1280;h=853|><|mask;x=0;y=0;data=3,3,~xyz|>';
    const recs = parseSamText(text);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ id: 0, x1: 16, y1: 279, x2: 669, y2: 671, w: 1280, h: 853, confidence: 0.9649 });
    expect(recs[0].mask).toEqual({ encoding: 'one_bit', payload: '!abc~def', width: 654, height: 393 });
    expect(recs[1].id).toBe(3);
    expect(recs[1].confidence).toBeUndefined();
    expect(recs[1].mask?.encoding).toBe('lossless');
    expect(parseSamText('')).toEqual([]);
    expect(parseSamText('\n')).toEqual([]);
  });

  it('fixture SAM answers from recordings by prompt, else from the canned scene, always labelled fixture', async () => {
    const log = new CallLog(() => {});
    const hash = frameHash('AAAA'); // the exact frame: a recording of it wins over everything else
    const rec = { kind: 'sam' as const, name: samKey('ceiling light', 1280, 960, hash), prompt: 'ceiling light', width: 1280, height: 960, frameHash: hash, model: 'sam-3.1', recordedAt: 'now', latencyMs: 1200, text: '<0f>0<|box;x1=600;y1=20;x2=800;y2=140;w=1280;h=960;c=0.95|><|mask;x=0;y=0;c=0.95;data=121,201,!zz|>' };
    const sam = new FixtureSam({ recorded: [rec], callLog: log });
    const r = await sam.segment('ceiling light', 'AAAA', { width: 1280, height: 960 });
    expect(r.source).toBe('fixture');
    expect(r.recordedFrom).toBe('sam-3.1');
    expect(r.records[0]).toMatchObject({ x1: 600, y1: 20 });
    const canned = await sam.segment('synthesizer', 'BBBB', { width: 640, height: 480 }); // not a sim-sized frame: the generic scene
    expect(canned.records).toHaveLength(1);
    expect(canned.recordedFrom).toBeUndefined();
    const all = await sam.segmentAll(['ceiling light', 'synthesizer', 'person'], 'BBBB', { width: 640, height: 480 });
    expect(all.map((x) => x.records.length)).toEqual([1, 1, 0]);
    expect(log.totals().calls).toBe(5);
    expect(cannedSamText('person', 1280, 960)).toBe('');
  });

  it('answers the sim room\'s own frames from its ground-truth outlines, never for people', () => {
    const light = simCannedRecords('ceiling light', 1280, 960);
    if (!light) return; // apps/sim not present in this checkout
    expect(light).toHaveLength(1);
    expect(light[0].polygon!.length).toBeGreaterThanOrEqual(3);
    expect(light[0].x1).toBeGreaterThan(500);
    expect(simCannedRecords('person', 1280, 960)).toEqual([]);
    expect(simCannedRecords('ceiling light', 320, 240)).toBeNull();
    const desk = simCannedRecords('synthesizer', 1280, 960, { position: { x: 0.92, y: 1.3, z: -2.52 } });
    expect(desk![0].y1).toBeGreaterThan(400); // the desk view, where the synth is large
  });
});

describe('recorded live SAM answers', () => {
  it('decodes a real one_bit mask into a raster and an outline', () => {
    const dir = new URL('../../fixtures/recorded/sam/', import.meta.url);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith('sam.synthesizer.1920x1280'));
    } catch {
      return;
    }
    if (!files.length) return;
    const rec = JSON.parse(readFileSync(new URL(files[0], dir), 'utf8')) as { text: string; model: string };
    expect(rec.model).toBe('sam-3.1');
    const [r] = parseSamText(rec.text);
    expect(r.mask?.encoding).toBe('one_bit');
    const raster = decodeMask(r);
    expect(raster).not.toBeNull();
    expect(raster!.length).toBe(r.mask!.width * r.mask!.height);
    let set = 0;
    for (const v of raster!) set += v;
    expect(set).toBeGreaterThan(raster!.length * 0.5); // a synth fills most of its box
    const poly = polygonFor({ data: raster!, width: r.mask!.width, height: r.mask!.height, x0: r.x1, y0: r.y1 }, [r.x1, r.y1, r.x2 - r.x1 + 1, r.y2 - r.y1 + 1]);
    expect(poly.length).toBeGreaterThanOrEqual(8);
    expect(poly.length).toBeLessThanOrEqual(64);
    expect(pointInPolygon((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2, poly)).toBe(true);
  });
});

describe('polygons', () => {
  it('traces a disc raster into a <= 64-point polygon and tests points against it', () => {
    const w = 120;
    const h = 100;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - 60) ** 2 + (y - 50) ** 2 <= 40 * 40) data[y * w + x] = 1;
    const raster = { data, width: w, height: h, x0: 500, y0: 300 };
    const outline = traceOutline(raster);
    expect(outline.length).toBeGreaterThan(30);
    const poly = polygonFor(raster, [500, 300, w, h]);
    expect(poly.length).toBeLessThanOrEqual(64);
    expect(poly.length).toBeGreaterThanOrEqual(8);
    expect(pointInPolygon(560, 350, poly)).toBe(true);
    expect(pointInPolygon(505, 305, poly)).toBe(false);
    const box = polygonBox(poly);
    expect(box[0]).toBeGreaterThanOrEqual(519);
    expect(box[0] + box[2]).toBeLessThanOrEqual(602);
    const many = Array.from({ length: 200 }, (_, i) => [Math.cos((i / 200) * 6.283) * 50, Math.sin((i / 200) * 6.283) * 50] as [number, number]);
    expect(simplifyPolygon(many).length).toBeLessThanOrEqual(64);
  });

  it('falls back to the box when there is no raster, and computes IoU', () => {
    expect(polygonFor(null, [10, 20, 30, 40])).toEqual([
      [10, 20],
      [40, 20],
      [40, 60],
      [10, 60],
    ]);
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(1 / 3, 5);
    expect(iou([0, 0, 10, 10], [20, 20, 5, 5])).toBe(0);
  });
});

describe('QR pairing decode', () => {
  function qrImage(text: string, scale = 6, width = 480, height = 360): DecodedImage {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const data = new Uint8Array(width * height * 4).fill(200);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const ox = Math.floor((width - size * scale) / 2);
    const oy = Math.floor((height - size * scale) / 2);
    for (let my = 0; my < size; my++) {
      for (let mx = 0; mx < size; mx++) {
        const dark = qr.modules.get(my, mx);
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = ((oy + my * scale + dy) * width + ox + mx * scale + dx) * 4;
            const v = dark ? 20 : 250;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
          }
        }
      }
    }
    return { width, height, data };
  }

  it('reads a pairing QR out of a JPEG frame and parses the pairing id and code', () => {
    const url = 'https://192.168.1.20:8443/p/abc123XYZ#K7Q4M2';
    const img = decodeJpeg(encodeJpeg(qrImage(url), 90));
    const seen = findQr(img);
    expect(seen?.text).toBe(url);
    expect(seen).toMatchObject({ pairingId: 'abc123XYZ', code: 'K7Q4M2' });
    expect(seen?.box?.[2]).toBeGreaterThan(50);
    expect(findQr(decodeJpeg(encodeJpeg(qrImage('hello world'), 90)))?.pairingId).toBeUndefined();
    expect(parsePairingQr('K7Q-4M2')).toEqual({ code: 'K7Q-4M2' });
    expect(parsePairingQr('CE1:K7Q4M2')).toEqual({ code: 'K7Q4M2' });
    expect(findQr(decodeJpeg(encodeJpeg(qrImage('CE1:K7Q4M2', 10), 90)))).toMatchObject({ code: 'K7Q4M2' });
    expect(parsePairingQr('nothing here')).toEqual({});
    const plain = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(128) };
    expect(findQr(plain)).toBeNull();
  });
});
