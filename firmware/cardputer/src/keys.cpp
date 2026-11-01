#include "keys.h"

#include <M5Cardputer.h>

#include <algorithm>
#include <memory>
#include <vector>

#include "utility/Adafruit_TCA8418/Adafruit_TCA8418.h"
#include "utility/Adafruit_TCA8418/Adafruit_TCA8418_registers.h"
#include "utility/Keyboard/KeyboardReader/IOMatrix.h"

namespace keys {
namespace {

uint32_t rebuilds_ = 0;

// Polled TCA8418 reader for the Cardputer-Adv. It never enables the controller's INT
// output, drains every queued event each update, and re-initialises the controller if
// it stops answering. Event codes are remapped to the same 14 x 4 grid the original
// Cardputer's matrix uses, so the shared key map applies.
class PolledTca8418 : public KeyboardReader {
 public:
  void begin() override {
    tca_.reset(new Adafruit_TCA8418());
    ok_ = tca_->begin();
    if (ok_) {
      tca_->matrix(7, 8);
      tca_->flush();
      tca_->writeRegister8(TCA8418_REG_INT_STAT, 0x1F);
    }
    _key_list.clear();
    lastTry_ = millis();
  }

  void update() override {
    if (!ok_) {
      if (millis() - lastTry_ > 1000) {
        rebuilds_++;
        begin();
      }
      return;
    }
    for (int i = 0; i < 16; i++) {
      const uint8_t n = tca_->available();
      if (n == 0) break;
      if (n > 10) {  // the FIFO is 10 deep: garbage means the bus or the chip is confused
        rebuilds_++;
        begin();
        return;
      }
      const uint8_t ev = tca_->getEvent();
      if (ev == 0) break;
      apply(ev);
    }
    tca_->writeRegister8(TCA8418_REG_INT_STAT, 0x1F);
  }

 private:
  void apply(uint8_t ev) {
    const bool down = (ev & 0x80) != 0;
    int code = ev & 0x7F;
    if (code == 0 || code > 80) return;  // 97+ are GPI events, not keys
    code--;
    const int row = code / 10, col = code % 10;
    Point2D_t p;
    p.x = row * 2 + (col > 3 ? 1 : 0);
    p.y = (col + 4) % 4;
    if (p.x < 0 || p.x > 13 || p.y < 0 || p.y > 3) return;
    auto it = std::find(_key_list.begin(), _key_list.end(), p);
    if (down) {
      if (it == _key_list.end()) _key_list.push_back(p);
    } else if (it != _key_list.end()) {
      _key_list.erase(it);
    }
  }

  std::unique_ptr<Adafruit_TCA8418> tca_;
  bool ok_ = false;
  uint32_t lastTry_ = 0;
};

std::vector<Point2D_t> prev_;

}  // namespace

void begin(bool adv) {
  if (adv) {
    M5Cardputer.Keyboard.begin(std::unique_ptr<KeyboardReader>(new PolledTca8418()));
  } else {
    M5Cardputer.Keyboard.begin(std::unique_ptr<KeyboardReader>(new IOMatrixKeyboardReader()));
  }
  prev_.clear();
}

int poll(Press* out, int cap) {
  auto& kb = M5Cardputer.Keyboard;
  kb.updateKeyList();
  kb.updateKeysState();
  const auto& cur = kb.keyList();
  const auto& st = kb.keysState();
  int n = 0;
  for (const auto& p : cur) {
    if (std::find(prev_.begin(), prev_.end(), p) != prev_.end()) continue;
    const KeyValue_t kv = kb.getKeyValue(p);
    const uint8_t base = (uint8_t)kv.value_first;
    if (base == KEY_FN || base == KEY_LEFT_SHIFT || base == KEY_LEFT_CTRL || base == KEY_LEFT_ALT ||
        base == KEY_OPT) {
      continue;  // modifiers only change the next key
    }
    Press pr{};
    pr.fn = st.fn;
    pr.shift = st.shift;
    pr.ctrl = st.ctrl;
    pr.alt = st.alt;
    pr.opt = st.opt;
    pr.base = base;
    uint8_t k;
    if (base == KEY_ENTER) {
      k = kEnter;
    } else if (base == KEY_BACKSPACE) {
      k = kBackspace;
    } else if (base == KEY_TAB) {
      k = kTab;
    } else if (pr.fn && base == ';') {
      k = kUp;
    } else if (pr.fn && base == '.') {
      k = kDown;
    } else if (pr.fn && base == ',') {
      k = kLeft;
    } else if (pr.fn && base == '/') {
      k = kRight;
    } else if (pr.fn && base == '`') {
      k = kEsc;
    } else {
      k = pr.shift ? (uint8_t)kv.value_second : base;
    }
    pr.key = k;
    if (n < cap) out[n++] = pr;
  }
  prev_.assign(cur.begin(), cur.end());
  return n;
}

bool held(char base) {
  auto& kb = M5Cardputer.Keyboard;
  for (const auto& p : kb.keyList()) {
    if (kb.getKeyValue(p).value_first == base) return true;
  }
  return false;
}

uint8_t arrow(const Press& p) {
  if (p.key == kUp || p.key == kDown || p.key == kLeft || p.key == kRight) return p.key;
  switch (p.base) {
    case ';': return kUp;
    case '.': return kDown;
    case ',': return kLeft;
    case '/': return kRight;
    default: return kNone;
  }
}

const char* name(const Press& p, char* buf, uint8_t cap) {
  const char* s = nullptr;
  switch (p.key) {
    case kEnter: s = "enter"; break;
    case kBackspace: s = "del"; break;
    case kTab: s = "tab"; break;
    case kEsc: s = "esc"; break;
    case kUp: s = "up"; break;
    case kDown: s = "down"; break;
    case kLeft: s = "left"; break;
    case kRight: s = "right"; break;
    case ' ': s = "space"; break;
    default: break;
  }
  if (s) {
    snprintf(buf, cap, "%s", s);
  } else {
    snprintf(buf, cap, "%c", (char)p.key);
  }
  return buf;
}

uint8_t parseName(const char* s) {
  if (!s || !*s) return kNone;
  if (!strcmp(s, "enter") || !strcmp(s, "return")) return kEnter;
  if (!strcmp(s, "space")) return ' ';
  if (!strcmp(s, "del") || !strcmp(s, "backspace")) return kBackspace;
  if (!strcmp(s, "tab")) return kTab;
  if (!strcmp(s, "esc")) return kEsc;
  if (!strcmp(s, "up")) return kUp;
  if (!strcmp(s, "down")) return kDown;
  if (!strcmp(s, "left")) return kLeft;
  if (!strcmp(s, "right")) return kRight;
  if (s[1] == 0) {
    const char c = s[0];
    return (uint8_t)((c >= 'A' && c <= 'Z') ? c - 'A' + 'a' : c);
  }
  return kNone;
}

bool matches(const Press& p, uint8_t code) {
  if (code == kNone) return false;
  if (code == kUp || code == kDown || code == kLeft || code == kRight) return arrow(p) == code;
  if (p.key == code || p.base == code) return true;
  return false;
}

uint32_t rebuilds() { return rebuilds_; }

}  // namespace keys
