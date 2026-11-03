const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const FF = Buffer.from([0xff]);

/**
 * Frames ffmpeg's image2pipe MJPEG output, including markers split across chunks.
 * This is a bounded framer for that known producer, not a general JPEG decoder:
 * arbitrary JPEG metadata can contain embedded images and requires marker parsing.
 */
export class JpegFrames {
  #onFrame;
  #maxBytes;
  #buffer = Buffer.alloc(0);
  #length = 0;
  #collecting = false;
  #pendingFF = false;

  constructor(onFrame, { maxBytes = 8 * 1024 * 1024 } = {}) {
    if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new RangeError('maxBytes must be an integer of at least 4');
    this.#onFrame = onFrame;
    this.#maxBytes = maxBytes;
  }

  reset() {
    this.#buffer = Buffer.alloc(0);
    this.#length = 0;
    this.#collecting = false;
    this.#pendingFF = false;
  }

  #append(bytes) {
    if (!this.#collecting || bytes.length === 0) return;
    const required = this.#length + bytes.length;
    if (required > this.#maxBytes) {
      // Discard the entire oversized frame; the scanner can recover at the next SOI.
      this.#collecting = false;
      this.#length = 0;
      return;
    }
    if (required > this.#buffer.length) {
      const capacity = Math.min(this.#maxBytes, Math.max(64 * 1024, this.#buffer.length * 2, required));
      const grown = Buffer.allocUnsafe(capacity);
      this.#buffer.copy(grown, 0, 0, this.#length);
      this.#buffer = grown;
    }
    bytes.copy(this.#buffer, this.#length);
    this.#length = required;
  }

  #start() {
    this.#collecting = true;
    this.#length = 0;
    this.#append(SOI);
  }

  #finish() {
    if (!this.#collecting) return;
    this.#append(EOI);
    if (!this.#collecting) return;
    // Consumers retain their own frame; later input never mutates an emitted JPEG.
    const frame = Buffer.from(this.#buffer.subarray(0, this.#length));
    this.#collecting = false;
    this.#length = 0;
    this.#onFrame(frame);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('JPEG input must be a Buffer');
    if (chunk.length === 0) return;
    let cursor = 0;
    if (this.#pendingFF) {
      this.#pendingFF = false;
      if (chunk[0] === 0xd8) { this.#start(); cursor = 1; }
      else if (chunk[0] === 0xd9) { this.#finish(); cursor = 1; }
      else this.#append(FF);
    }
    let segment = cursor;
    while (cursor < chunk.length) {
      const marker = chunk.indexOf(0xff, cursor);
      if (marker < 0) break;
      if (marker === chunk.length - 1) {
        this.#append(chunk.subarray(segment, marker));
        this.#pendingFF = true;
        return;
      }
      const code = chunk[marker + 1];
      if (code === 0xd8 || code === 0xd9) {
        this.#append(chunk.subarray(segment, marker));
        if (code === 0xd8) this.#start();
        else this.#finish();
        cursor = marker + 2;
        segment = cursor;
      } else {
        // Advance one byte so FF FF D8 still recognizes the second FF as SOI.
        cursor = marker + 1;
      }
    }
    this.#append(chunk.subarray(segment));
  }
}
