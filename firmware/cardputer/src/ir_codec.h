// IR frame codec: byte frames <-> mark/space timings, and analysis of raw captures.
// Pure C++ (no Arduino), so it can be compiled and tested on the host.
//
// Conventions (shared with the companion and scripts/ir-spike.py):
//   * Timings are microseconds, alternating mark/space, starting with a mark.
//   * Bytes are listed in send order and each byte is sent LSB-first (bit 0 first),
//     the native NEC and AEHA order. "82 6D BE 41" is NEC address 0x6D82, command 0xBE.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace ir {

constexpr size_t kMaxRaw = 1024;    // longest timing array we accept or send
constexpr size_t kMaxBytes = 36;    // longest byte frame (AEHA allows 35 data bytes)

struct PulseFormat {
  uint16_t header[4];   // mark, space[, mark, space]
  uint8_t headerLen;    // 0..4
  uint16_t oneMark, oneSpace;
  uint16_t zeroMark, zeroSpace;
  uint16_t trailerMark;  // 0 = none
  bool msbFirst;
};

PulseFormat necFormat();                   // 9000/4500, 562 + 562|1688, trailer 562
PulseFormat aehaFormat(uint16_t unitUs);   // 8T/4T, T + T|3T, trailer T (T ~ 350..500)
PulseFormat irisFormat();                  // Iris Ohyama 5.x/6.x pulse-width (low confidence)

// Encodes bytes into timings. Returns the number of entries written, 0 if `cap` is too small.
size_t encode(const PulseFormat& f, const uint8_t* bytes, size_t nbytes, uint16_t* out, size_t cap);

// "2C 52 09 2F 26", "2C52092F26", "0x2C,0x52". Returns the byte count, or -1 on bad input.
int parseHex(const char* s, uint8_t* out, size_t cap);
// Writes "2C 52 09 2F 26" (always NUL-terminated, truncated to fit).
void formatHex(const uint8_t* b, size_t n, char* buf, size_t cap);

enum class Proto : uint8_t { Unknown = 0, NEC = 1, NECRepeat = 2, AEHA = 3 };
const char* protoName(Proto p);

struct Analysis {
  Proto proto = Proto::Unknown;
  uint16_t unitUs = 0;          // estimated T of the first frame
  uint16_t bits = 0;            // pulse-distance bits decoded from the first frame
  uint8_t bytes[kMaxBytes] = {0};
  uint8_t nbytes = 0;
  bool checkOk = false;         // NEC: cmd ^ ~cmd == FF. AEHA: customer-code parity nibble.
  uint16_t firstFrameLen = 0;   // entries in the first frame (it ends with a mark)
  uint8_t frames = 0;           // frames in the capture, split at spaces > 8 ms
  uint8_t sameFrames = 0;       // later frames identical to the first (the remote's own repeats)
  uint8_t necRepeats = 0;       // NEC "key held" repeat codes
  uint32_t gapUs = 0;           // the space after the first frame, if any
  uint16_t marks = 0;
  uint32_t durationUs = 0;
};

Analysis analyze(const uint16_t* us, size_t n);

// True when two captures are the same code: same decoded bytes when both decode,
// otherwise the same first-frame length with every entry within 25 % (or 200 us).
bool sameCode(const uint16_t* a, size_t na, const uint16_t* b, size_t nb);

// One-line description, e.g. "AEHA 40b T432 2C 52 09 2F 26 x2" or "RAW 67 marks".
void describe(const Analysis& a, char* buf, size_t cap);

}  // namespace ir
