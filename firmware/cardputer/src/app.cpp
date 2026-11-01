#include "app.h"

#include <M5Cardputer.h>
#include <string.h>
#include <strings.h>

#include "proto.h"
#include "spike.h"
#include "store.h"
#include "ui.h"

namespace app {

State S;

namespace {
uint16_t tmp[cfg::kIrMaxEntries];

bool overlayMode(Mode m) { return m == Mode::Word || m == Mode::Pair || m == Mode::Learn || m == Mode::Boot; }
}  // namespace

void enterMode(Mode m) {
  const Mode old = S.mode;
  if (m == old) {
    ui::dirty();
    return;
  }
  if (old == Mode::Spike) spike::leave();
  if (old == Mode::Learn) {
    S.learn.on = false;
    irnode::rxStop();
  }
  if (old == Mode::Pair) M5.Display.setBrightness(180);
  if (overlayMode(m) && !overlayMode(old)) S.before = old;
  S.mode = m;
  if (m == Mode::Spike) spike::enter();
  if (m == Mode::Pair) M5.Display.setBrightness(255);  // the headset camera reads the QR
  ui::dirty();
}

bool fireSlot(const char* slot, uint8_t phase, int16_t step, int16_t of, const char* label) {
  if (irnode::busy()) return false;
  store::SlotInfo si;
  const int n = store::loadSlot(slot, tmp, cfg::kIrMaxEntries, &si);
  if (n < 0) return false;
  irnode::Meta m;
  m.phase = phase;
  m.step = step;
  m.of = of;
  m.tx = irnode::defaultTx();
  m.khz = si.khz ? si.khz : cfg::kIrDefaultKhz;
  m.repeats = si.repeats;
  m.gapMs = si.gapMs ? si.gapMs : 40;
  snprintf(m.label, sizeof(m.label), "%s", label && label[0] ? label : slot);
  if (irnode::validate(tmp, (size_t)n, m)) return false;
  return irnode::submit(m, tmp, (size_t)n);
}

bool fireBytes(const char* fmt, uint16_t unitUs, const char* hex, uint8_t repeats, uint16_t gapMs,
               const irnode::Meta& meta, const char** err) {
  if (irnode::busy()) {
    if (err) *err = "busy";
    return false;
  }
  uint8_t b[ir::kMaxBytes];
  const int nb = ir::parseHex(hex, b, sizeof(b));
  if (nb <= 0) {
    if (err) *err = "bad_args";
    return false;
  }
  ir::PulseFormat f;
  if (!strcasecmp(fmt, "NEC")) {
    f = ir::necFormat();
  } else if (!strcasecmp(fmt, "AEHA") || !strcasecmp(fmt, "KASEIKYO")) {
    f = ir::aehaFormat(unitUs ? unitUs : 425);
  } else if (!strcasecmp(fmt, "IRIS")) {
    f = ir::irisFormat();
  } else {
    if (err) *err = "unsupported";
    return false;
  }
  const size_t n = ir::encode(f, b, (size_t)nb, tmp, cfg::kIrMaxEntries);
  if (!n) {
    if (err) *err = "bad_args";
    return false;
  }
  irnode::Meta m = meta;
  m.repeats = repeats;
  m.gapMs = gapMs;
  const char* e = irnode::validate(tmp, n, m);
  if (e) {
    if (err) *err = e;
    return false;
  }
  return irnode::submit(m, tmp, n);
}

bool storeCapture(const char* slot, const char* label) {
  if (!S.cap.n || !store::validName(slot)) return false;
  store::SlotInfo si;
  memset(&si, 0, sizeof(si));
  snprintf(si.name, sizeof(si.name), "%s", slot);
  snprintf(si.label, sizeof(si.label), "%s", label ? label : "");
  si.khz = cfg::kIrDefaultKhz;
  si.proto = (uint8_t)S.cap.a.proto;
  si.verified = 0;
  si.repeats = 0;  // the capture already holds the remote's own repeats
  si.gapMs = 0;
  si.count = S.cap.n;
  return store::saveSlot(si, S.cap.us);
}

}  // namespace app
