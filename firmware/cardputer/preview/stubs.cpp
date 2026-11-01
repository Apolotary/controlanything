// Fake state behind the screens: a few stored codes, an idle IR node.
#include <string.h>
#include "preview_shim.h"
#include "../src/app.h"
#include "../src/keys.h"
#include "../src/spike.h"
#include "../src/store.h"

PreviewSerial Serial;
PreviewM5 M5;
uint32_t g_now = 10000;
uint32_t millis() { return g_now; }

namespace app { State S; }
namespace spike { State P; }

namespace store {
static SlotInfo slots[7];
int g_slots = 0;
void fakeSlots(int n) {
  const char* names[] = {"full", "off", "night", "brighter", "darker", "warmer", "cooler"};
  const char* labels[] = {"全灯", "消灯", "常夜灯", "明るく", "暗く", "暖かい光", "白い光"};
  g_slots = n;
  for (int i = 0; i < n; i++) {
    memset(&slots[i], 0, sizeof(SlotInfo));
    strcpy(slots[i].name, names[i]);
    strcpy(slots[i].label, labels[i]);
    slots[i].khz = 38;
    slots[i].proto = 3;
    slots[i].count = 167;
    slots[i].verified = i < 3 ? 1 : (i == 3 ? 2 : 0);
  }
}
int slotCount() { return g_slots; }
bool slotAt(int i, SlotInfo& out) { if (i < 0 || i >= g_slots) return false; out = slots[i]; return true; }
int findSlot(const char* name) { for (int i = 0; i < g_slots; i++) if (!strcmp(slots[i].name, name)) return i; return -1; }
char getAnswer(const char* c, uint8_t part) { return (!strcmp(c, "pana1-off") && part == 0) ? 'n' : 0; }
}  // namespace store

namespace irnode {
bool busy() { return false; }
bool rxActive() { return false; }
uint8_t defaultTx() { return 0; }
}  // namespace irnode

namespace keys {
bool held(char) { return false; }
}  // namespace keys
