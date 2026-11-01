// Shared application state: what the screens draw and the modes switch between.
#pragma once
#include <stdint.h>

#include "config.h"
#include "ir_codec.h"
#include "ir_node.h"

namespace app {

enum class Mode : uint8_t { Boot, Idle, Pair, Menu, Learn, Spike, Word };

struct MenuItem {
  char id[24];
  char label[20];
  char keyName[8];
  uint8_t key;      // keys:: code
  bool armed;
  char slot[16];    // optional: a learned code this item fires when the menu is local
};

struct MenuBar {
  char id[16];
  char label[16];
  char unit[6];
  char lo[10], hi[10];  // step-bar end labels ("WARM", "COOL")
  float value;          // 0..1
  uint8_t steps;        // > 0: draw as dots
  bool big;             // draw as the large numeral
};

struct Menu {
  bool valid = false;
  bool local = false;   // keys fire the items' learned slots on the device
  char title[28] = {0};
  MenuItem items[12];
  uint8_t nItems = 0;
  MenuBar bars[3];
  uint8_t nBars = 0;
  int8_t hot = -1;      // item highlighted after a press
  uint32_t hotAt = 0;
};

enum PairStage : uint8_t { kPairNone, kPairPending, kPairApproved, kPairDenied, kPairExpired, kPairLinked };

struct Pair {
  uint8_t stage = kPairNone;
  char code[12] = {0};
  char display[16] = {0};
  char qr[160] = {0};
  uint32_t expiresAt = 0;   // millis()
  uint32_t stageAt = 0;
  char name[32] = {0};
  bool codeOnly = false;
};

struct Overlay {
  bool active = false;
  bool word = false;        // one big word for the camera
  char title[24] = {0};
  char text[64] = {0};
  float progress = -1.f;    // < 0: none
  uint8_t tone = 0;         // 0 info, 1 ok, 2 warn, 3 bad
  uint32_t until = 0;
};

struct SendFx {
  uint32_t at = 0;          // when the last send finished (beam animation clock)
  uint32_t lastOnAt = 0;    // when the send flash last turned on (at most once a second)
  uint32_t litUntil = 0;    // the flash is lit while millis() < litUntil
  bool sending = false;     // a frame is on the air right now
  char line[48] = {0};      // "sent koizumi/dimmer"
  int16_t step = -1, of = -1;
  uint8_t phase = 0;
};

struct Capture {
  uint16_t us[cfg::kLearnMaxEntries];
  uint16_t n = 0;
  bool truncated = false;
  ir::Analysis a;
  uint32_t at = 0;
  char desc[72] = {0};
};

// A learn request from the host (serial `learn`).
struct HostLearn {
  bool on = false;
  char id[25] = {0};
  char label[28] = {0};
  char slot[16] = {0};
  int16_t step = -1, of = -1;
  uint32_t deadline = 0;
  uint16_t frames = 0;
  bool stored = false;
};

struct State {
  Mode mode = Mode::Boot;
  Mode before = Mode::Idle;   // where Word / Pair return to
  bool adv = false;
  char board[16] = {0};
  char chip[16] = {0};
  uint32_t bootAt = 0;
  uint32_t lastHostMs = 0;    // last command from the host
  bool hostSeen = false;
  char hostName[32] = {0};
  char lastCmd[48] = {0};
  uint32_t lastCmdAt = 0;
  Menu menu;
  Pair pair;
  Overlay overlay;
  Overlay word;
  SendFx fx;
  Capture cap;
  HostLearn learn;
};

extern State S;

void enterMode(Mode m);
// Fire a learned slot from the device itself (spike, local menu). Returns false if busy/missing.
bool fireSlot(const char* slot, uint8_t phase, int16_t step, int16_t of, const char* label);
// Fire byte-frame codes with the on-device codec (spike candidates, serial protocol/bytes form).
bool fireBytes(const char* fmt, uint16_t unitUs, const char* hex, uint8_t repeats, uint16_t gapMs,
               const irnode::Meta& meta, const char** err);
// Remote's 2-frame press etc.: store the capture under a slot.
bool storeCapture(const char* slot, const char* label);

}  // namespace app
