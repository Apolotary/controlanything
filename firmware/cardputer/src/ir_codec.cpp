#include "ir_codec.h"

#include <stdio.h>
#include <string.h>

namespace ir {

PulseFormat necFormat() {
  PulseFormat f{};
  f.header[0] = 9000;
  f.header[1] = 4500;
  f.headerLen = 2;
  f.oneMark = 562;
  f.oneSpace = 1688;
  f.zeroMark = 562;
  f.zeroSpace = 562;
  f.trailerMark = 562;
  f.msbFirst = false;
  return f;
}

PulseFormat aehaFormat(uint16_t t) {
  if (t < 300 || t > 600) t = 425;
  PulseFormat f{};
  f.header[0] = (uint16_t)(8 * t);
  f.header[1] = (uint16_t)(4 * t);
  f.headerLen = 2;
  f.oneMark = t;
  f.oneSpace = (uint16_t)(3 * t);
  f.zeroMark = t;
  f.zeroSpace = t;
  f.trailerMark = t;
  f.msbFirst = false;
  return f;
}

PulseFormat irisFormat() {
  // research/devices/jp-ceiling-light-ir.json protocols.IRIS_PWM_proprietary:
  // two-mark leader, pulse WIDTH bits (1 = 3T mark, 0 = 1T mark, 1T space), T = 500 us.
  PulseFormat f{};
  f.header[0] = 2076;
  f.header[1] = 948;
  f.header[2] = 5548;
  f.header[3] = 964;
  f.headerLen = 4;
  f.oneMark = 1500;
  f.oneSpace = 500;
  f.zeroMark = 500;
  f.zeroSpace = 500;
  f.trailerMark = 500;
  f.msbFirst = true;
  return f;
}

size_t encode(const PulseFormat& f, const uint8_t* bytes, size_t nbytes, uint16_t* out, size_t cap) {
  const size_t need = f.headerLen + nbytes * 16 + (f.trailerMark ? 1 : 0);
  if (need > cap || nbytes > kMaxBytes) return 0;
  size_t n = 0;
  for (uint8_t i = 0; i < f.headerLen; i++) out[n++] = f.header[i];
  for (size_t b = 0; b < nbytes; b++) {
    for (uint8_t k = 0; k < 8; k++) {
      const uint8_t bit = f.msbFirst ? (uint8_t)((bytes[b] >> (7 - k)) & 1) : (uint8_t)((bytes[b] >> k) & 1);
      out[n++] = bit ? f.oneMark : f.zeroMark;
      out[n++] = bit ? f.oneSpace : f.zeroSpace;
    }
  }
  if (f.trailerMark) out[n++] = f.trailerMark;
  return n;
}

static int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int parseHex(const char* s, uint8_t* out, size_t cap) {
  if (!s) return -1;
  size_t n = 0;
  const char* p = s;
  while (*p) {
    char c = *p;
    if (c == ' ' || c == ',' || c == ':' || c == '-' || c == '\t' || c == '_') {
      p++;
      continue;
    }
    if (c == '0' && (p[1] == 'x' || p[1] == 'X')) {
      p += 2;
      continue;
    }
    const int hi = hexVal(c);
    if (hi < 0) return -1;
    const int lo = hexVal(p[1]);
    if (n >= cap) return -1;
    if (lo < 0) {  // a single digit followed by a separator or the end: "0x9"
      out[n++] = (uint8_t)hi;
      p += 1;
    } else {
      out[n++] = (uint8_t)(hi * 16 + lo);
      p += 2;
    }
  }
  return (int)n;
}

void formatHex(const uint8_t* b, size_t n, char* buf, size_t cap) {
  if (!cap) return;
  buf[0] = 0;
  size_t used = 0;
  for (size_t i = 0; i < n; i++) {
    if (used + 4 > cap) break;
    used += (size_t)snprintf(buf + used, cap - used, i ? " %02X" : "%02X", b[i]);
  }
}

const char* protoName(Proto p) {
  switch (p) {
    case Proto::NEC: return "NEC";
    case Proto::NECRepeat: return "NEC-REPEAT";
    case Proto::AEHA: return "AEHA";
    default: return "UNKNOWN";
  }
}

static bool near(uint32_t v, uint32_t target, uint32_t pct, uint32_t floorUs) {
  uint32_t tol = target * pct / 100;
  if (tol < floorUs) tol = floorUs;
  return v + tol >= target && v <= target + tol;
}

// Index one past the end of the frame that starts at `start` (frames end with a mark).
static size_t frameEnd(const uint16_t* us, size_t n, size_t start) {
  // The leader space (start + 1) never ends a frame; any later space > 8 ms does
  // (the longest in-frame space is a ~4.5 ms NEC leader space).
  for (size_t i = start + 3; i < n; i += 2) {
    if (us[i] > 8000) return i;
  }
  return n;
}

// Pulse-distance decode of [start, end): header of 2, then mark/space pairs.
static void decodeDistance(const uint16_t* us, size_t start, size_t end, Analysis& a) {
  // T = median-ish of the marks after the header: use the mean of marks within 2x of the minimum.
  uint32_t minMark = 0xFFFFFFFF;
  for (size_t i = start + 2; i < end; i += 2) {
    if (us[i] < minMark) minMark = us[i];
  }
  if (minMark == 0xFFFFFFFF || minMark == 0) return;
  uint32_t sum = 0, cnt = 0;
  for (size_t i = start + 2; i < end; i += 2) {
    if (us[i] <= minMark * 2) {
      sum += us[i];
      cnt++;
    }
  }
  const uint32_t t = cnt ? sum / cnt : minMark;
  // Receivers stretch marks and shrink spaces by ~50-150 us, so report T as the mean of
  // (mark + space) / 2 over the zero bits, which cancels the stretch.
  uint32_t zsum = 0, zcnt = 0;
  for (size_t i = start + 2; i + 1 < end; i += 2) {
    if (us[i + 1] <= 2 * t) {
      zsum += (uint32_t)us[i] + us[i + 1];
      zcnt++;
    }
  }
  a.unitUs = (uint16_t)(zcnt ? zsum / (2 * zcnt) : t);
  uint16_t bits = 0;
  memset(a.bytes, 0, sizeof(a.bytes));
  for (size_t i = start + 2; i + 1 < end; i += 2) {
    const uint32_t space = us[i + 1];
    if (bits >= kMaxBytes * 8) break;
    const uint8_t bit = space > 2 * t ? 1 : 0;
    if (bit) a.bytes[bits / 8] |= (uint8_t)(1u << (bits % 8));
    bits++;
  }
  a.bits = bits;
  a.nbytes = (uint8_t)((bits + 7) / 8);
}

Analysis analyze(const uint16_t* us, size_t n) {
  Analysis a;
  if (!us || n < 2) return a;
  for (size_t i = 0; i < n; i++) {
    a.durationUs += us[i];
    if ((i & 1) == 0) a.marks++;
  }
  const size_t e1 = frameEnd(us, n, 0);
  a.firstFrameLen = (uint16_t)e1;
  a.frames = 1;
  if (e1 < n) a.gapUs = us[e1];

  const uint32_t l0 = us[0], l1 = us[1];
  if (l0 >= 7000 && l0 <= 12000 && l1 >= 3500 && l1 <= 6000) {
    decodeDistance(us, 0, e1, a);
    if (a.bits == 32) {
      a.proto = Proto::NEC;
      a.checkOk = (uint8_t)(a.bytes[2] ^ a.bytes[3]) == 0xFF;
    }
  } else if (l0 >= 7000 && l0 <= 12000 && l1 >= 1700 && l1 <= 2800 && e1 <= 4) {
    a.proto = Proto::NECRepeat;
  } else if (l0 >= 2400 && l0 <= 4800 && l1 * 100 >= l0 * 35 && l1 * 100 <= l0 * 65) {
    decodeDistance(us, 0, e1, a);
    if (a.bits >= 16 && a.bits % 8 == 0) {
      a.proto = Proto::AEHA;
      const uint8_t p = (uint8_t)((a.bytes[0] & 0xF) ^ (a.bytes[0] >> 4) ^ (a.bytes[1] & 0xF) ^ (a.bytes[1] >> 4));
      a.checkOk = a.nbytes >= 3 && (a.bytes[2] & 0xF) == p;
    }
  }
  if (a.proto == Proto::Unknown) {
    a.bits = 0;
    a.nbytes = 0;
  }

  // Later frames: the remote's own repeats, NEC hold codes, or something else.
  size_t start = e1 + 1;
  while (start < n) {
    const size_t e = frameEnd(us, n, start);
    a.frames++;
    const size_t len = e - start;
    if (len <= 4 && near(us[start], 9000, 25, 500) && start + 1 < n && near(us[start + 1], 2250, 30, 300)) {
      a.necRepeats++;
    } else if (len == e1) {
      bool same = true;
      for (size_t i = 0; i < len && same; i++) same = near(us[start + i], us[i], 25, 200);
      if (same) a.sameFrames++;
    }
    if (a.frames == 255) break;
    start = e + 1;
  }
  return a;
}

bool sameCode(const uint16_t* a, size_t na, const uint16_t* b, size_t nb) {
  const Analysis x = analyze(a, na), y = analyze(b, nb);
  if (x.proto != Proto::Unknown && x.proto == y.proto) {
    return x.bits == y.bits && memcmp(x.bytes, y.bytes, x.nbytes) == 0;
  }
  if (x.firstFrameLen != y.firstFrameLen || x.firstFrameLen < 4) return false;
  for (size_t i = 0; i < x.firstFrameLen; i++) {
    if (!near(b[i], a[i], 25, 200)) return false;
  }
  return true;
}

void describe(const Analysis& a, char* buf, size_t cap) {
  if (!cap) return;
  char hex[3 * kMaxBytes + 1];
  if (a.proto == Proto::NEC || a.proto == Proto::AEHA) {
    formatHex(a.bytes, a.nbytes, hex, sizeof(hex));
    const unsigned copies = 1u + a.sameFrames;
    if (copies > 1) {
      snprintf(buf, cap, "%s %ub T%u %s x%u", protoName(a.proto), a.bits, a.unitUs, hex, copies);
    } else {
      snprintf(buf, cap, "%s %ub T%u %s", protoName(a.proto), a.bits, a.unitUs, hex);
    }
  } else if (a.proto == Proto::NECRepeat) {
    snprintf(buf, cap, "NEC repeat code");
  } else {
    snprintf(buf, cap, "RAW %u marks %lu ms", a.marks, (unsigned long)((a.durationUs + 500) / 1000));
  }
}

}  // namespace ir
