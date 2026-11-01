// Persistent state in NVS (ESP32 Preferences): learned IR codes, spike answers, settings.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace store {

struct SlotInfo {
  char name[16];      // [a-z0-9_-], unique
  char label[28];     // what the user pressed, e.g. "全灯" (UTF-8)
  uint8_t khz;
  uint8_t proto;      // ir::Proto
  uint8_t verified;   // 0 untested, 1 the light changed, 2 no change
  uint8_t repeats;    // extra frames to send (normally 0: the capture already holds them)
  uint16_t gapMs;
  uint16_t count;     // timing entries
};

void begin();

// Learned codes. Saving a name that exists overwrites it.
int slotCount();
bool slotAt(int index, SlotInfo& out);
int findSlot(const char* name);
bool saveSlot(const SlotInfo& info, const uint16_t* us);
// Loads timings into `out` (capacity `cap`); returns the count, or -1.
int loadSlot(const char* name, uint16_t* out, size_t cap, SlotInfo* info);
bool setVerified(const char* name, uint8_t verified);
bool deleteSlot(const char* name);
void clearSlots();

// Spike answers: part 0 = main code, 1 = confirm code. ans = 'y', 'n' or 0.
void putAnswer(const char* candId, uint8_t part, char ans);
char getAnswer(const char* candId, uint8_t part);
void clearAnswers();

// Settings.
uint8_t txPin();             // 0 = built-in LED (G44), 1 = IR Unit LED (G2)
void setTxPin(uint8_t v);
bool saveMenu(const char* json);   // the last persisted hack menu (a `menu` line)
size_t loadMenu(char* buf, size_t cap);
void clearMenu();

bool validName(const char* s);

}  // namespace store
