import assert from 'node:assert/strict';
import test from 'node:test';
import { JpegFrames } from './mjpeg.mjs';

const jpeg = (payload) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(payload), Buffer.from([0xff, 0xd9])]);
const first = jpeg([1, 2, 0xff, 0x00, 3, 0xff, 0xdb, 4]);
const second = jpeg([5, 6, 7]);
const collect = (options) => {
  const frames = [];
  const parser = new JpegFrames((frame) => frames.push(frame), options);
  return { parser, frames };
};

test('preserves frames for every two-chunk split, including either marker', () => {
  const source = Buffer.concat([Buffer.from('noise'), first, second, Buffer.from('tail')]);
  for (let split = 0; split <= source.length; split++) {
    const { parser, frames } = collect();
    parser.push(source.subarray(0, split));
    parser.push(source.subarray(split));
    assert.deepEqual(frames, [first, second], `split at byte ${split}`);
  }
});

test('accepts byte-at-a-time and empty chunks without duplicate or partial output', () => {
  const { parser, frames } = collect();
  for (const byte of Buffer.concat([first, second])) {
    parser.push(Buffer.from([byte]));
    parser.push(Buffer.alloc(0));
  }
  assert.deepEqual(frames, [first, second]);
});

test('finds multiple frames in one chunk and ignores unmatched end markers', () => {
  const { parser, frames } = collect();
  parser.push(Buffer.concat([Buffer.from([0xff, 0xd9, 0xff]), first, second, Buffer.from([0xff, 0xd9])]));
  assert.deepEqual(frames, [first, second]);
});

test('preserves stuffed bytes and repeated FF bytes around fragmented markers', () => {
  const image = jpeg([0xff, 0x00, 1, 0xff, 0xff, 0xdb, 2, 0xff, 0x00]);
  const { parser, frames } = collect();
  parser.push(Buffer.from([0xff]));
  for (const byte of image) parser.push(Buffer.from([byte]));
  assert.deepEqual(frames, [image]);
});

test('discards an incomplete frame when a fresh start marker arrives', () => {
  const { parser, frames } = collect();
  parser.push(Buffer.from([0xff, 0xd8, 1, 2, 0xff]));
  parser.push(second.subarray(1));
  assert.deepEqual(frames, [second]);
});

test('accepts the exact limit, drops oversized frames, and recovers in the same chunk', () => {
  const exact = jpeg(Buffer.alloc(12, 1));
  const tooLarge = jpeg(Buffer.alloc(13, 2));
  const { parser, frames } = collect({ maxBytes: 16 });
  parser.push(Buffer.concat([exact, tooLarge, second]));
  assert.deepEqual(frames, [exact, second]);
});

test('drops oversized partial input and recovers across fragmented SOI and EOI', () => {
  const { parser, frames } = collect({ maxBytes: 16 });
  parser.push(Buffer.from([0xff, 0xd8]));
  parser.push(Buffer.alloc(2 * 1024 * 1024, 1));
  parser.push(Buffer.from([0xff]));
  parser.push(second.subarray(1, second.length - 1));
  assert.deepEqual(frames, []);
  parser.push(second.subarray(-1));
  assert.deepEqual(frames, [second]);
});

test('bounds incomplete frames even when every input chunk is one byte', () => {
  const { parser, frames } = collect({ maxBytes: 8 });
  for (const byte of jpeg(Buffer.alloc(200, 1))) parser.push(Buffer.from([byte]));
  parser.push(second);
  assert.deepEqual(frames, [second]);
});

test('reset discards pending markers and partial frame data', () => {
  const { parser, frames } = collect();
  parser.push(Buffer.from([0xff])); parser.reset(); parser.push(Buffer.from([0xd8, 1, 0xff, 0xd9]));
  parser.push(first.subarray(0, first.length - 1)); parser.reset(); parser.push(first.subarray(-1));
  assert.deepEqual(frames, []);
  parser.push(second);
  assert.deepEqual(frames, [second]);
});

test('copies input and emitted data instead of retaining mutable producer buffers', () => {
  const { parser, frames } = collect();
  const input = Buffer.from(first);
  parser.push(input.subarray(0, input.length - 2));
  input.fill(0, 0, input.length - 2);
  parser.push(Buffer.from([0xff, 0xd9]));
  assert.deepEqual(frames, [first]);
  parser.push(second);
  assert.deepEqual(frames, [first, second]);
  frames[0].fill(0);
  parser.push(first);
  assert.deepEqual(frames[2], first);
});

test('clears the completed frame before invoking a callback that throws', () => {
  const failure = new Error('consumer failed');
  let calls = 0;
  const parser = new JpegFrames(() => { calls++; if (calls === 1) throw failure; });
  assert.throws(() => parser.push(first), failure);
  parser.push(second);
  assert.equal(calls, 2);
});

test('validates parser limits and input types', () => {
  assert.throws(() => new JpegFrames(null), TypeError);
  for (const maxBytes of [0, 3, 4.5, NaN, Infinity]) assert.throws(() => collect({ maxBytes }), RangeError);
  const { parser, frames } = collect({ maxBytes: 4 });
  assert.throws(() => parser.push('not bytes'), TypeError);
  parser.push(jpeg([]));
  assert.deepEqual(frames, [jpeg([])]);
});
