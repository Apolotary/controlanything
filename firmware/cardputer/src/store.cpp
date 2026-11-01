#include "store.h"

#include <Preferences.h>
#include <string.h>

#include "config.h"

namespace store {
namespace {

Preferences codes;   // "ce-codes": s0..s11 = SlotInfo + uint16 timings
Preferences spike;   // "ce-spike": m.<cand> / c.<cand> = 'y' | 'n'
Preferences prefs;   // "ce-cfg": tx, menu

SlotInfo index_[cfg::kMaxSlots];
bool used_[cfg::kMaxSlots];

void key(char* buf, int i) {
  buf[0] = 's';
  if (i >= 10) {
    buf[1] = (char)('0' + i / 10);
    buf[2] = (char)('0' + i % 10);
    buf[3] = 0;
  } else {
    buf[1] = (char)('0' + i);
    buf[2] = 0;
  }
}

void answerKey(char* buf, size_t cap, const char* cand, uint8_t part) {
  snprintf(buf, cap, "%c.%.12s", part ? 'c' : 'm', cand);
}

}  // namespace

bool validName(const char* s) {
  if (!s || !*s) return false;
  size_t n = 0;
  for (const char* p = s; *p; p++, n++) {
    const char c = *p;
    const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok || n >= 15) return false;
  }
  return true;
}

void begin() {
  codes.begin("ce-codes", false);
  spike.begin("ce-spike", false);
  prefs.begin("ce-cfg", false);
  for (int i = 0; i < cfg::kMaxSlots; i++) {
    used_[i] = false;
    char k[4];
    key(k, i);
    if (codes.getBytesLength(k) >= sizeof(SlotInfo)) {
      if (codes.getBytes(k, &index_[i], sizeof(SlotInfo)) == sizeof(SlotInfo)) {
        index_[i].name[sizeof(index_[i].name) - 1] = 0;
        index_[i].label[sizeof(index_[i].label) - 1] = 0;
        used_[i] = validName(index_[i].name);
      }
    }
  }
}

int slotCount() {
  int n = 0;
  for (int i = 0; i < cfg::kMaxSlots; i++) n += used_[i] ? 1 : 0;
  return n;
}

bool slotAt(int index, SlotInfo& out) {
  int n = 0;
  for (int i = 0; i < cfg::kMaxSlots; i++) {
    if (!used_[i]) continue;
    if (n == index) {
      out = index_[i];
      return true;
    }
    n++;
  }
  return false;
}

static int rawFind(const char* name) {
  for (int i = 0; i < cfg::kMaxSlots; i++) {
    if (used_[i] && strncmp(index_[i].name, name, sizeof(index_[i].name)) == 0) return i;
  }
  return -1;
}

int findSlot(const char* name) {
  const int raw = rawFind(name);
  if (raw < 0) return -1;
  int n = 0;
  for (int i = 0; i < raw; i++) n += used_[i] ? 1 : 0;
  return n;
}

bool saveSlot(const SlotInfo& info, const uint16_t* us) {
  if (!validName(info.name) || info.count < 2 || info.count > cfg::kLearnMaxEntries) return false;
  int raw = rawFind(info.name);
  if (raw < 0) {
    for (int i = 0; i < cfg::kMaxSlots && raw < 0; i++) {
      if (!used_[i]) raw = i;
    }
  }
  if (raw < 0) return false;
  const size_t len = sizeof(SlotInfo) + (size_t)info.count * sizeof(uint16_t);
  uint8_t* buf = new uint8_t[len];
  memcpy(buf, &info, sizeof(SlotInfo));
  memcpy(buf + sizeof(SlotInfo), us, (size_t)info.count * sizeof(uint16_t));
  char k[4];
  key(k, raw);
  const bool ok = codes.putBytes(k, buf, len) == len;
  delete[] buf;
  if (ok) {
    index_[raw] = info;
    used_[raw] = true;
  }
  return ok;
}

int loadSlot(const char* name, uint16_t* out, size_t cap, SlotInfo* info) {
  const int raw = rawFind(name);
  if (raw < 0) return -1;
  char k[4];
  key(k, raw);
  const size_t len = codes.getBytesLength(k);
  if (len < sizeof(SlotInfo)) return -1;
  uint8_t* buf = new uint8_t[len];
  const bool ok = codes.getBytes(k, buf, len) == len;
  int n = -1;
  if (ok) {
    SlotInfo si;
    memcpy(&si, buf, sizeof(SlotInfo));
    const size_t have = (len - sizeof(SlotInfo)) / sizeof(uint16_t);
    if (si.count <= have && si.count <= cap) {
      memcpy(out, buf + sizeof(SlotInfo), (size_t)si.count * sizeof(uint16_t));
      n = si.count;
      if (info) *info = si;
    }
  }
  delete[] buf;
  return n;
}

bool setVerified(const char* name, uint8_t verified) {
  const int raw = rawFind(name);
  if (raw < 0) return false;
  static uint16_t tmp[cfg::kLearnMaxEntries];
  SlotInfo si;
  const int n = loadSlot(name, tmp, cfg::kLearnMaxEntries, &si);
  if (n < 0) return false;
  si.verified = verified;
  return saveSlot(si, tmp);
}

bool deleteSlot(const char* name) {
  const int raw = rawFind(name);
  if (raw < 0) return false;
  char k[4];
  key(k, raw);
  codes.remove(k);
  used_[raw] = false;
  return true;
}

void clearSlots() {
  codes.clear();
  for (int i = 0; i < cfg::kMaxSlots; i++) used_[i] = false;
}

void putAnswer(const char* candId, uint8_t part, char ans) {
  char k[16];
  answerKey(k, sizeof(k), candId, part);
  spike.putUChar(k, (uint8_t)ans);
}

char getAnswer(const char* candId, uint8_t part) {
  char k[16];
  answerKey(k, sizeof(k), candId, part);
  return (char)spike.getUChar(k, 0);
}

void clearAnswers() { spike.clear(); }

uint8_t txPin() { return prefs.getUChar("tx", 0); }
void setTxPin(uint8_t v) { prefs.putUChar("tx", v ? 1 : 0); }

bool saveMenu(const char* json) {
  const size_t n = strlen(json);
  if (n == 0 || n > 4000) return false;
  return prefs.putBytes("menu", json, n) == n;
}

size_t loadMenu(char* buf, size_t cap) {
  const size_t n = prefs.getBytesLength("menu");
  if (n == 0 || n + 1 > cap) return 0;
  const size_t got = prefs.getBytes("menu", buf, n);
  buf[got] = 0;
  return got;
}

void clearMenu() { prefs.remove("menu"); }

}  // namespace store
