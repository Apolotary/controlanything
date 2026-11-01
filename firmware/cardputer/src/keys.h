// Keyboard: board-specific reader + press-edge detection.
//
// Original Cardputer: the M5Cardputer IOMatrix reader (74HC138 scan, sees levels).
// Cardputer-Adv: our own polled TCA8418 reader that drains the whole event FIFO every
// loop instead of relying on the INT edge (the stock reader pops one event per frame
// and can wedge with INT stuck low). The TCA8418 reports edges only, so a key held
// through power-up is invisible: boot shortcuts are "press during the splash".
#pragma once
#include <stdint.h>

namespace keys {

// Non-printable key codes we hand out.
enum : uint8_t {
  kNone = 0,
  kBackspace = 0x08,
  kTab = 0x09,
  kEnter = 0x0D,
  kEsc = 0x1B,
  kUp = 0x11,
  kDown = 0x12,
  kLeft = 0x13,
  kRight = 0x14,
};

struct Press {
  uint8_t key;   // printable ASCII (lower case unless shift) or one of the codes above
  uint8_t base;  // the unshifted legend of the physical key (';' for Fn+; = kUp)
  bool fn, shift, ctrl, alt, opt;
};

void begin(bool adv);
// Call once per loop. Writes up to `cap` new presses (in order) and returns the count.
int poll(Press* out, int cap);
// Is the key with this unshifted legend held right now?
bool held(char base);
// Arrow for a press: Fn+; . , / and also the bare ; . , / keys (they carry the arrows).
uint8_t arrow(const Press& p);
// "a", "enter", "space", "left", ... (for the serial `key` event).
const char* name(const Press& p, char* buf, uint8_t cap);
// Parse a key name from a hack menu ("1", "enter", "left") into a key code.
uint8_t parseName(const char* s);
// Does press `p` trigger a binding with key code `code`?
bool matches(const Press& p, uint8_t code);
uint32_t rebuilds();   // TCA8418 recoveries (ADV only)

}  // namespace keys
