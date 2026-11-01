#include "ui.h"

#ifdef CE_PREVIEW
#include "preview_shim.h"  // host build that renders screens to PNG (preview/)
#else
#include <M5Cardputer.h>
#endif
#include <lgfx/utility/lgfx_qrcode.h>
#include <string.h>

#include "app.h"
#include "candidates.h"
#include "config.h"
#include "ir_node.h"
#include "spike.h"
#include "store.h"

namespace ui {
namespace {

constexpr int W = 240, H = 135;
constexpr uint32_t kBg = 0x0A0E12u;
constexpr uint32_t kFg = 0xF3F7FAu;
constexpr uint32_t kCyan = 0x38F0FFu;
constexpr uint32_t kVolt = 0xEEFF41u;
constexpr uint32_t kOk = 0x5CFFA3u;
constexpr uint32_t kBad = 0xFF5A3Cu;
constexpr uint32_t kDim = 0x71808Cu;
constexpr uint32_t kLine = 0x23384Au;
constexpr uint32_t kPanel = 0x111922u;

M5Canvas canvas(&M5.Display);
bool dirty_ = true;
uint32_t lastFrame = 0;
bool canvasOk = false;

const lgfx::IFont* const F12 = &fonts::DejaVu12;
const lgfx::IFont* const F18 = &fonts::DejaVu18;
const lgfx::IFont* const F24 = &fonts::DejaVu24;
const lgfx::IFont* const F40 = &fonts::DejaVu40;
const lgfx::IFont* const F72 = &fonts::DejaVu72;
const lgfx::IFont* const FBIG = &fonts::AsciiFont24x48;
const lgfx::IFont* const FJA = &fonts::efontJA_16;
const lgfx::IFont* const FJA12 = &fonts::efontJA_12;

bool ascii(const char* s) {
  for (; s && *s; s++) {
    if ((uint8_t)*s >= 0x80) return false;
  }
  return true;
}

// Draws text; falls back to the Japanese font when the string is not plain ASCII.
int text(const char* s, int x, int y, const lgfx::IFont* f, uint32_t color, textdatum_t d = top_left) {
  if (!s) return 0;
  if (!ascii(s)) f = (f == F12) ? FJA12 : FJA;
  canvas.setFont(f);
  canvas.setTextDatum(d);
  canvas.setTextColor(color);
  canvas.drawString(s, x, y);
  return canvas.textWidth(s);
}

int textW(const char* s, const lgfx::IFont* f) {
  if (!ascii(s)) f = (f == F12) ? FJA12 : FJA;
  canvas.setFont(f);
  return canvas.textWidth(s);
}

// Draws text cut to `maxW` pixels (".." marks the cut; UTF-8 safe).
int textFit(const char* s, int x, int y, const lgfx::IFont* f, uint32_t color, int maxW, textdatum_t d = top_left) {
  if (!s) return 0;
  if (textW(s, f) <= maxW) return text(s, x, y, f, color, d);
  char buf[96];
  size_t n = strlen(s);
  if (n > sizeof(buf) - 3) n = sizeof(buf) - 3;
  memcpy(buf, s, n);
  while (n > 0) {
    n--;
    while (n > 0 && ((uint8_t)buf[n] & 0xC0) == 0x80) n--;  // back to a character start
    buf[n] = '.';
    buf[n + 1] = '.';
    buf[n + 2] = 0;
    if (textW(buf, f) <= maxW) break;
  }
  return text(buf, x, y, f, color, d);
}

void dot(int x, int y, uint32_t c) { canvas.fillRect(x, y, 3, 3, c); }

uint32_t linkColor(uint32_t now) {
  if (app::S.fx.sending || now - app::S.fx.at < 400) return kVolt;
  if (app::S.hostSeen && now - app::S.lastHostMs < 120000) return kCyan;
  if ((bool)Serial) return kDim;  // a host has the port open but has not spoken yet
  return app::S.hostSeen ? kBad : kDim;
}

// Flash state: lit for 120 ms after a send, re-triggering at most once a second;
// sends that arrive faster keep it lit instead of blinking.
bool flashLit(uint32_t now) { return (int32_t)(app::S.fx.litUntil - now) > 0; }

// "IR NODE" + dot + "READY": the left title, dot-separated parts.
void topBar(const char* a, const char* b, uint32_t now) {
  canvas.fillRect(0, 0, W, 17, kPanel);
  int x = 6;
  x += text(a, x, 2, F12, kCyan);
  if (b && b[0]) {
    dot(x + 4, 8, kDim);
    text(b, x + 11, 2, F12, kFg);
  }
  canvas.fillCircle(W - 9, 8, 4, linkColor(now));
  canvas.fillRect(0, 17, W, 2, flashLit(now) ? kVolt : kLine);
}

void sendBar(int x, int y, int w, int h, uint32_t now) {
  if (flashLit(now)) {
    canvas.fillRect(x, y, w, h, kVolt);
  } else {
    canvas.drawRect(x, y, w, h, kLine);
    canvas.drawRect(x + 1, y + 1, w - 2, h - 2, kLine);
  }
}

void valueBar(int x, int y, int w, int h, float v, uint32_t color) {
  if (v < 0) v = 0;
  if (v > 1) v = 1;
  canvas.fillRect(x, y, w, h, kLine);
  const int f = (int)(v * (float)w + 0.5f);
  if (f > 0) canvas.fillRect(x, y, f, h, color);
}

// IR beam: three chevrons rising along the right edge toward the IR window (top of the
// device) for 700 ms after a send. Motion only, no flashing.
void beam(uint32_t now) {
  const app::SendFx& fx = app::S.fx;
  if (!fx.at || fx.sending) return;
  const uint32_t t = now - fx.at;
  if (t > 900) return;
  const int x = W - 9;
  for (int k = 0; k < 3; k++) {
    const int32_t local = (int32_t)t - k * 130;
    if (local < 0 || local > 520) continue;
    const int y = 118 - (int)(local * 96 / 520);
    const uint32_t c = local < 300 ? kVolt : kCyan;
    canvas.fillTriangle(x - 6, y + 5, x, y - 1, x + 6, y + 5, c);
    canvas.fillTriangle(x - 6, y + 9, x, y + 3, x + 6, y + 9, kBg);
  }
}

void arrowGlyph(uint8_t a, int cx, int cy, uint32_t c) {
  switch (a) {
    case keys::kLeft: canvas.fillTriangle(cx + 3, cy - 4, cx + 3, cy + 4, cx - 3, cy, c); break;
    case keys::kRight: canvas.fillTriangle(cx - 3, cy - 4, cx - 3, cy + 4, cx + 3, cy, c); break;
    case keys::kUp: canvas.fillTriangle(cx - 4, cy + 3, cx + 4, cy + 3, cx, cy - 3, c); break;
    case keys::kDown: canvas.fillTriangle(cx - 4, cy - 3, cx + 4, cy - 3, cx, cy + 3, c); break;
    default: break;
  }
}

// Key chip: a filled key cap and a label. Returns the width used.
int chip(int x, int y, uint8_t key, const char* keyName, const char* label, bool armed, bool hot) {
  const uint32_t cap = hot ? kVolt : (armed ? kCyan : kDim);
  int kw = 14;
  char kt[8] = {0};
  const bool isArrow = key == keys::kLeft || key == keys::kRight || key == keys::kUp || key == keys::kDown;
  if (!isArrow) {
    if (key == keys::kEnter) {
      strcpy(kt, "ENT");
    } else if (key == ' ') {
      strcpy(kt, "SPC");
    } else if (key == keys::kTab) {
      strcpy(kt, "TAB");
    } else if (key == keys::kBackspace) {
      strcpy(kt, "DEL");
    } else if (keyName && keyName[0] && keyName[1] == 0) {
      kt[0] = (char)((keyName[0] >= 'a' && keyName[0] <= 'z') ? keyName[0] - 32 : keyName[0]);
    } else if (key >= 0x20 && key < 0x7F) {
      kt[0] = (char)key;
    } else {
      strcpy(kt, "?");
    }
    kw = textW(kt, F12) + 6;
    if (kw < 14) kw = 14;
  }
  canvas.fillRoundRect(x, y, kw, 15, 3, cap);
  if (isArrow) {
    arrowGlyph(key, x + kw / 2, y + 7, kBg);
  } else {
    text(kt, x + kw / 2, y + 1, F12, kBg, top_center);
  }
  const int lw = text(label, x + kw + 4, y + 1, F12, armed ? kFg : kDim);
  return kw + 4 + lw + 9;
}

void wave(int x, int y, int w, int h, const uint16_t* us, uint16_t n, uint16_t frameLen) {
  canvas.fillRect(x, y + h, w, 2, kLine);
  if (!n) return;
  const uint16_t len = frameLen && frameLen <= n ? frameLen : n;
  uint32_t total = 0;
  for (uint16_t i = 0; i < len; i++) total += us[i];
  if (!total) return;
  uint32_t t = 0;
  for (uint16_t i = 0; i < len; i++) {
    if ((i & 1) == 0) {
      const int x0 = x + (int)((uint64_t)t * w / total);
      const int x1 = x + (int)((uint64_t)(t + us[i]) * w / total);
      canvas.fillRect(x0, y, x1 - x0 < 1 ? 1 : x1 - x0, h, kVolt);
    }
    t += us[i];
  }
}

// Side length in modules of the smallest QR (ECC L) that holds `s`, 0 if none <= v10.
int qrModules(const char* s) {
  static uint8_t buf[512];
  for (uint8_t v = 1; v <= 10; v++) {
    if (lgfx_qrcode_getBufferSize(v) > sizeof(buf)) break;
    QRCode q;
    if (lgfx_qrcode_initText(&q, buf, v, 0, s) == 0) return q.size;
  }
  return 0;
}

void fmtStep(char* buf, size_t cap, const char* word, int16_t step, int16_t of) {
  if (step >= 0 && of > 0) {
    snprintf(buf, cap, "%s %d / %d", word, step, of);
  } else if (step >= 0) {
    snprintf(buf, cap, "%s %d", word, step);
  } else {
    snprintf(buf, cap, "%s", word);
  }
}

// The status line every IR screen shares: "sent <label>" for a second after a send.
const char* sentLine(uint32_t now, char* buf, size_t cap) {
  const app::SendFx& fx = app::S.fx;
  if (fx.sending) {
    snprintf(buf, cap, "sending %s", fx.line);
    return buf;
  }
  if (fx.at && now - fx.at < 1500) {
    snprintf(buf, cap, "sent %s", fx.line);
    return buf;
  }
  return nullptr;
}

// ---- screens ------------------------------------------------------------------------

void drawBoot(uint32_t now) {
  topBar("IR NODE", CE_FW_VERSION, now);
  text("CONTROL", 12, 30, F24, kCyan);
  text("EVERYTHING", 12, 56, F24, kFg);
  char b[48];
  snprintf(b, sizeof(b), "%s  %s", app::S.board, app::S.chip);
  text(b, 12, 86, F12, kDim);
  const uint32_t t = now - app::S.bootAt;
  const float p = t >= cfg::kBootWindowMs ? 1.f : (float)t / cfg::kBootWindowMs;
  valueBar(12, 104, 216, 4, p, kCyan);
  int x = 12;
  x += chip(x, 115, 's', "s", "spike", true, keys::held('s'));
  chip(x, 115, 'l', "l", "learn", true, keys::held('l'));
}

void drawIdle(uint32_t now) {
  const app::SendFx& fx = app::S.fx;
  // Host-driven link discovery / replay: "LINK · try 7 / 36" while the sends keep coming.
  const bool linking = (fx.phase == irnode::kPhaseTry || fx.phase == irnode::kPhaseReplay) && fx.step >= 0 &&
                       (fx.sending || (fx.at && now - fx.at < 8000));
  const char* st = irnode::busy() || fx.sending ? "SENDING" : (irnode::rxActive() ? "LEARNING" : "READY");
  topBar(linking ? "LINK" : "IR NODE", st, now);
  if (linking) {
    char c[32];
    fmtStep(c, sizeof(c), fx.phase == irnode::kPhaseTry ? "try" : "replay", fx.step, fx.of);
    text(c, 10, 24, F24, kVolt);
  } else if (app::S.hostSeen) {
    text("LINKED", 10, 26, F18, kCyan);
    if (app::S.hostName[0]) textFit(app::S.hostName, 10 + textW("LINKED", F18) + 10, 30, F12, kDim, 140);
  } else {
    text("NO HOST", 10, 26, F18, kDim);
    textFit("USB-C to the Mac companion", 10 + textW("NO HOST", F18) + 8, 30, F12, kDim, 130);
  }
  char buf[64];
  const char* s = sentLine(now, buf, sizeof(buf));
  if (s) {
    textFit(s, 10, 52, F12, kVolt, 210);
  } else if (app::S.lastCmd[0]) {
    snprintf(buf, sizeof(buf), "last: %s", app::S.lastCmd);
    textFit(buf, 10, 52, F12, kFg, 210);
  } else {
    text("no IR sent yet", 10, 52, F12, kDim);
  }
  snprintf(buf, sizeof(buf), "codes %d  tx %s", store::slotCount(),
           irnode::defaultTx() == irnode::kTxGrove ? "IR Unit G2" : "LED G44");
  text(buf, 10, 70, F12, kDim);
  sendBar(20, 90, 200, 8, now);
  int x = 6;
  x += chip(x, 112, 's', "s", "spike", true, false);
  x += chip(x, 112, 'l', "l", "learn", true, false);
  if (app::S.menu.valid) x += chip(x, 112, 'h', "h", "hacks", true, false);
  if (app::S.pair.stage == app::kPairPending) chip(x, 112, 'p', "p", "pair", true, false);
}

void drawPair(uint32_t now) {
  const app::Pair& P = app::S.pair;
  canvas.fillScreen(kBg);
  if (P.stage == app::kPairApproved || P.stage == app::kPairLinked) {
    topBar("LINK", "PAIRED", now);
    text("LINKED", W / 2, 34, F40, kOk, top_center);
    char b[48];
    snprintf(b, sizeof(b), "linked to %s", P.name[0] ? P.name : "MacBook");
    text(b, W / 2, 84, F12, kFg, top_center);
    return;
  }
  if (P.stage == app::kPairDenied || P.stage == app::kPairExpired) {
    topBar("LINK", P.stage == app::kPairDenied ? "DENIED" : "EXPIRED", now);
    text(P.stage == app::kPairDenied ? "DENIED" : "EXPIRED", W / 2, 34, F40, kBad, top_center);
    text("ask the companion for a new code", W / 2, 84, F12, kDim, top_center);
    return;
  }
  const int32_t left = (int32_t)(P.expiresAt - now);
  const uint32_t secs = left > 0 ? (uint32_t)left / 1000 : 0;
  char cd[16];
  snprintf(cd, sizeof(cd), "%lu:%02lu", (unsigned long)(secs / 60), (unsigned long)(secs % 60));
  const bool blinkOn = ((now / 1000) % 2) == 0;  // 0.5 Hz toggle: well under 1 Hz of flashes

  // Normalise the code to "K7Q4M2" for the two-line layout.
  char code[12] = {0};
  size_t n = 0;
  for (const char* p = P.code[0] ? P.code : P.display; *p && n < sizeof(code) - 1; p++) {
    if (*p != '-' && *p != ' ') code[n++] = *p;
  }

  if (P.codeOnly || !P.qr[0]) {
    topBar("LINK", "CODE", now);
    text(P.display[0] ? P.display : code, W / 2, 34, FBIG, kFg, top_center);
    text("type it on the Mac or the iPhone", W / 2, 92, F12, kDim, top_center);
    text(cd, W / 2, 112, F18, kCyan, top_center);
    if (blinkOn) canvas.fillRect(W / 2 + 34, 118, 8, 8, kVolt);
    return;
  }
  // QR on the left, full height: dark modules on white (standard polarity) with a
  // 2-module white quiet zone, module size chosen as large as the version allows.
  // A short QR text (e.g. "CE1:K7Q4M2", version 1) gives 5 px modules; a ~60-char URL
  // (version 4) only 3 px, which the headset camera needs to be much closer to read.
  const int q = H;
  canvas.fillRect(0, 0, q, q, 0xFFFFFFu);
  const int modules = qrModules(P.qr);
  if (modules > 0) {
    int t = q / (modules + 4);
    if (t < 1) t = 1;
    const int qw = modules * t;
    const int off = (q - qw) / 2;
    canvas.qrcode(P.qr, off, off, qw, 1, false);
  }
  const int rx = q + 4;
  const int cw = W - rx - 2;
  text("LINK CODE", rx + cw / 2, 4, F12, kCyan, top_center);
  char a[4] = {0}, b[4] = {0};
  memcpy(a, code, n >= 3 ? 3 : n);
  if (n > 3) memcpy(b, code + 3, n - 3 >= 3 ? 3 : n - 3);
  text(a, rx + cw / 2, 20, F40, kFg, top_center);
  text(b, rx + cw / 2, 60, F40, kFg, top_center);
  text(cd, rx + cw / 2, 100, F18, kCyan, top_center);
  if (blinkOn) canvas.fillRect(rx + 2, 106, 8, 8, kVolt);
  text("c: code", rx + cw / 2, 121, F12, kDim, top_center);
}

void drawMenu(uint32_t now) {
  const app::Menu& M = app::S.menu;
  char title[40];
  snprintf(title, sizeof(title), "%s", M.title);
  topBar(title, "IR", now);
  int y = 22;
  const app::MenuBar* big = nullptr;
  for (uint8_t i = 0; i < M.nBars; i++) {
    if (M.bars[i].big && !M.bars[i].steps) big = &M.bars[i];
  }
  if (!big && M.nBars && !M.bars[0].steps) big = &M.bars[0];
  if (big) {
    char num[8];
    snprintf(num, sizeof(num), "%d", (int)(big->value * 100.f + 0.5f));
    const int nw = textW(num, F72);
    const int uw = textW(big->unit[0] ? big->unit : "%", F18);
    const int x0 = (W - (nw + 4 + uw)) / 2;
    text(num, x0, 18, F72, kFg);
    text(big->unit[0] ? big->unit : "%", x0 + nw + 4, 56, F18, kCyan);
    text(big->label, 10, 24, F12, kDim);
    valueBar(20, 80, 200, 8, big->value, kCyan);
    y = 91;
  }
  // Step bars as dots ("WARM o o o . . COOL"), other bars as thin bars.
  for (uint8_t i = 0; i < M.nBars && y < 104; i++) {
    const app::MenuBar& b = M.bars[i];
    if (&b == big) continue;
    if (b.steps) {
      const char* lo = b.lo[0] ? b.lo : b.label;
      int x = 10;
      x += text(lo, x, y, F12, kDim) + 8;
      const int lit = (int)(b.value * b.steps + 0.5f);
      for (uint8_t k = 0; k < b.steps; k++) {
        const int cx = x + 5 + k * 15;
        if (k < lit) {
          canvas.fillCircle(cx, y + 6, 5, kCyan);
        } else {
          canvas.drawCircle(cx, y + 6, 5, kDim);
          canvas.drawCircle(cx, y + 6, 4, kDim);
        }
      }
      if (b.hi[0]) text(b.hi, x + b.steps * 15 + 6, y, F12, kDim);
      y += 16;
    } else {
      text(b.label, 10, y, F12, kDim);
      valueBar(80, y + 3, 140, 6, b.value, kCyan);
      y += 14;
    }
  }
  const bool legendOnly = big != nullptr || M.nBars > 1;
  if (legendOnly) {
    // Key legend along the bottom (two rows when needed).
    int x = 4, row = 0;
    for (uint8_t i = 0; i < M.nItems; i++) {
      const app::MenuItem& it = M.items[i];
      const int w = textW(it.label, F12) + 32;
      if (x + w > W - 2) {
        if (row == 1) break;
        row = 1;
        x = 4;
      }
      const bool hot = M.hot == (int8_t)i && now - M.hotAt < 350;
      x += chip(x, row ? 120 : 104, it.key, it.keyName, it.label, it.armed, hot);
    }
  } else {
    // No big value: the items are the screen, two columns.
    for (uint8_t i = 0; i < M.nItems; i++) {
      const app::MenuItem& it = M.items[i];
      const int col = i % 2, r = i / 2;
      const bool hot = M.hot == (int8_t)i && now - M.hotAt < 350;
      chip(6 + col * 118, y + r * 18, it.key, it.keyName, it.label, it.armed, hot);
    }
  }
  char buf[64];
  const char* s = sentLine(now, buf, sizeof(buf));
  if (s && !legendOnly) text(s, 10, H - 14, F12, kVolt);
}

// Waveform (first frame) plus two lines: format summary, then the bytes.
void drawCapture(int y) {
  const app::Capture& c = app::S.cap;
  if (!c.n) {
    canvas.fillRect(10, y + 12, 220, 2, kLine);
    return;
  }
  wave(10, y, 220, 12, c.us, c.n, c.a.firstFrameLen);
  const ir::Analysis& a = c.a;
  char l1[64], l2[64];
  const unsigned copies = 1u + a.sameFrames;
  if (a.proto == ir::Proto::NEC || a.proto == ir::Proto::AEHA) {
    snprintf(l1, sizeof(l1), "%s %ub T%u%s  %u marks", ir::protoName(a.proto), a.bits, a.unitUs,
             copies > 1 ? (copies == 2 ? " x2" : " x3+") : "", a.marks);
    ir::formatHex(a.bytes, a.nbytes, l2, sizeof(l2));
  } else {
    snprintf(l1, sizeof(l1), "RAW  %u marks  %lu ms%s", a.marks, (unsigned long)((a.durationUs + 500) / 1000),
             c.truncated ? "  cut" : "");
    snprintf(l2, sizeof(l2), "replays exactly as captured");
  }
  textFit(l1, 10, y + 18, F12, kCyan, 224);
  textFit(l2, 10, y + 32, F12, kFg, 224);
}

void captureFill(uint32_t now, int y) {
  const app::Capture& c = app::S.cap;
  float p = 0.f;
  if (c.at) {
    const uint32_t t = now - c.at;
    p = t >= 300 ? 1.f : (float)t / 300.f;
  }
  valueBar(20, y, 200, 8, p, kVolt);
}

void drawLearn(uint32_t now) {
  const app::HostLearn& L = app::S.learn;
  char st[24];
  fmtStep(st, sizeof(st), "", L.step, L.of);
  topBar("LEARN", st[0] == ' ' ? st + 1 : st, now);
  char p[48];
  if (L.label[0]) {
    snprintf(p, sizeof(p), "press %s", L.label);
  } else {
    snprintf(p, sizeof(p), "press the next button");
  }
  textFit(p, 10, 24, F18, kFg, 224);
  captureFill(now, 48);
  drawCapture(62);
  const int32_t left = (int32_t)(L.deadline - now);
  char b[48];
  snprintf(b, sizeof(b), "listening on G1  %lds", (long)(left > 0 ? left / 1000 : 0));
  text(b, 10, H - 14, F12, kDim);
}

void drawWord(uint32_t now) {
  (void)now;
  canvas.fillScreen(kBg);
  const app::Overlay& O = app::S.word;
  text(O.text, W / 2, (H - 48) / 2, FBIG, kFg, top_center);
}

void drawOverlay(uint32_t now) {
  const app::Overlay& O = app::S.overlay;
  if (!O.active || O.word) return;
  const uint32_t tones[] = {kCyan, kOk, kVolt, kBad};
  const uint32_t tc = tones[O.tone & 3];
  canvas.fillRoundRect(8, 30, W - 16, 78, 6, kPanel);
  canvas.drawRoundRect(8, 30, W - 16, 78, 6, tc);
  canvas.drawRoundRect(9, 31, W - 18, 76, 5, tc);
  textFit(O.title, 18, 38, F12, tc, W - 40);
  if (textW(O.text, F18) <= W - 40) {
    text(O.text, 18, 56, F18, kFg);
  } else {
    textFit(O.text, 18, 60, F12, kFg, W - 40);
  }
  if (O.progress >= 0.f) valueBar(18, 88, W - 36, 8, O.progress, tc);
  (void)now;
}

// ---- spike screens --------------------------------------------------------------------

void spikeMsg(int y) {
  if (spike::P.msg[0]) textFit(spike::P.msg, 6, y, F12, kVolt, W - 12);
}

void drawSpikeHome(uint32_t now) {
  topBar("G1 SPIKE", "CEILING LIGHT", now);
  struct Row {
    char k;
    const char* a;
    const char* b;
  };
  char learned[24];
  snprintf(learned, sizeof(learned), "%d learned", store::slotCount());
  const Row rows[] = {{'1', "LEARN + REPLAY", "IR Unit"},
                      {'2', "CANDIDATES", "11 codes"},
                      {'3', "REPLAY", learned},
                      {'4', "REMOTE", "dim, bright"}};
  for (int i = 0; i < 4; i++) {
    const int y = 24 + i * 19;
    char k[2] = {rows[i].k, 0};
    chip(6, y, (uint8_t)rows[i].k, k, rows[i].a, true, false);
    textFit(rows[i].b, 148, y + 1, F12, kDim, W - 150);
  }
  char t[40];
  snprintf(t, sizeof(t), "tx %s", irnode::defaultTx() == irnode::kTxGrove ? "IR Unit G2" : "LED G44");
  int x = 6;
  x += chip(x, 102, 't', "t", t, true, false);
  chip(x, 102, '`', "`", "back", true, false);
  spikeMsg(120);
}

void drawSpikeCand(uint32_t now) {
  const spike::State& P = spike::P;
  const cand::Candidate& c = cand::kList[P.cand];
  char st[24];
  snprintf(st, sizeof(st), "try %d / %d", P.cand + 1, cand::kCount);
  topBar("LINK", st, now);
  char b[64];
  if (c.ch) {
    snprintf(b, sizeof(b), "%s CH%u", c.brand, c.ch);
  } else {
    snprintf(b, sizeof(b), "%s", c.brand);
  }
  text(b, 8, 22, F18, kFg);
  const bool confirm = P.stage == spike::Stage::ConfReady || P.stage == spike::Stage::ConfAsk;
  if (c.fmt == cand::Fmt::AEHA) {
    snprintf(b, sizeof(b), "%s  AEHA T%u%s  %s", confirm ? c.confirmWhat : c.what, c.unitUs, c.repeats ? " x2" : "",
             c.confidence);
  } else {
    snprintf(b, sizeof(b), "%s  %s%s  %s", confirm ? c.confirmWhat : c.what, cand::fmtName(c.fmt),
             c.repeats ? " x2" : "", c.confidence);
  }
  textFit(b, 8, 44, F12, kCyan, W - 16);
  textFit(confirm ? c.confirmBytes : c.bytes, 8, 58, F12, kFg, 150);
  {
    const char a0 = store::getAnswer(c.id, 0), a1 = store::getAnswer(c.id, 1);
    if (a0 || a1) {
      char sv[24];
      snprintf(sv, sizeof(sv), "saved %c/%c", a0 ? a0 : '-', a1 ? a1 : '-');
      text(sv, W - 8, 58, F12, kDim, top_right);
    }
  }

  const char* prompt = "";
  uint32_t pc = kVolt;
  switch (P.stage) {
    case spike::Stage::CandReady: prompt = "ENTER = send it"; pc = kFg; break;
    case spike::Stage::CandAsk: prompt = "light changed?  y / n"; break;
    case spike::Stage::ConfReady: prompt = "ENTER = send confirm"; pc = kFg; break;
    case spike::Stage::ConfAsk: prompt = "did it react?  y / n"; break;
    case spike::Stage::CandHit:
      prompt = P.lastConfirmOk ? "HIT: off + on both work" : "HIT: main code works";
      pc = kOk;
      break;
    case spike::Stage::CandDone: prompt = "end of list  ENTER"; pc = kFg; break;
    default: break;
  }
  text(prompt, 8, 74, F18, pc);
  sendBar(20, 96, 200, 6, now);
  char s[64];
  const char* sl = sentLine(now, s, sizeof(s));
  if (sl) {
    text(sl, 6, 106, F12, kVolt);
  } else {
    text("r resend  ,/ prev next  t tx", 6, 106, F12, kDim);
  }
  spikeMsg(121);
}

void drawSpikeLearn(uint32_t now) {
  const spike::State& P = spike::P;
  const cand::LearnButton& b = cand::kLearnButtons[P.learnIdx];
  char st[24];
  snprintf(st, sizeof(st), "%d / %d", P.learnIdx + 1, cand::kLearnCount);
  topBar("LEARN", st, now);
  char p[48];
  snprintf(p, sizeof(p), P.stage == spike::Stage::LearnAgain ? "again: %s" : "press %s", b.ja);
  const int w = text(p, 8, 22, F18, kFg);
  text(b.en, 8 + w + 8, 26, F12, kDim);
  captureFill(now, 44);
  drawCapture(56);
  text("ENT keep  r retry  TAB skip", 6, 106, F12, kDim);
  spikeMsg(121);
}

void drawSpikeReplay(uint32_t now) {
  const spike::State& P = spike::P;
  char st[24];
  snprintf(st, sizeof(st), "replay %d / %d", P.replayIdx + 1, store::slotCount());
  topBar("LINK", st, now);
  store::SlotInfo si;
  if (store::slotAt(P.replayIdx, si)) {
    char b[64];
    snprintf(b, sizeof(b), "#%d %s", P.replayIdx + 1, si.label[0] ? si.label : si.name);
    const int w = text(b, 8, 22, F18, kFg);
    text(si.name, 8 + w + 8, 26, F12, kDim);
    snprintf(b, sizeof(b), "%s  %u entries  %s", ir::protoName((ir::Proto)si.proto), si.count,
             si.verified == 1 ? "worked" : si.verified == 2 ? "no change" : "untested");
    text(b, 8, 46, F12, si.verified == 1 ? kOk : (si.verified == 2 ? kBad : kCyan));
  }
  text(P.stage == spike::Stage::ReplayAsk ? "light changed?  y / n" : "ENTER = replay it", 8, 66, F18,
       P.stage == spike::Stage::ReplayAsk ? kVolt : kFg);
  sendBar(20, 92, 200, 6, now);
  char s[64];
  const char* sl = sentLine(now, s, sizeof(s));
  text(sl ? sl : "r resend  ,/ prev next  t tx", 6, 104, F12, sl ? kVolt : kDim);
  spikeMsg(121);
}

void drawSpikeDone(uint32_t now) {
  topBar("LINK", "RESULT", now);
  const int n = store::slotCount();
  for (int i = 0; i < n && i < 7; i++) {
    store::SlotInfo si;
    if (!store::slotAt(i, si)) continue;
    const int col = i % 2, row = i / 2;
    const int x = 8 + col * 116, y = 24 + row * 18;
    const uint32_t c = si.verified == 1 ? kOk : si.verified == 2 ? kBad : kDim;
    canvas.fillRect(x, y + 3, 8, 8, c);
    text(si.label[0] ? si.label : si.name, x + 14, y, F12, kFg);
  }
  text("ENTER remote   ` back", 6, 106, F12, kDim);
  spikeMsg(121);
}

void drawSpikeRemote(uint32_t now) {
  topBar("REMOTE", "LEARNED CODES", now);
  struct K {
    uint8_t key;
    const char* name;
    const char* slot;
  };
  const K ks[] = {{keys::kLeft, "dim", "darker"},   {keys::kRight, "bright", "brighter"}, {keys::kUp, "warm", "warmer"},
                  {keys::kDown, "cool", "cooler"},  {keys::kEnter, "on/off", nullptr},     {'n', "night", "night"}};
  for (int i = 0; i < 6; i++) {
    const bool have = ks[i].slot ? store::findSlot(ks[i].slot) >= 0
                                 : (store::findSlot("full") >= 0 || store::findSlot("off") >= 0);
    char kn[2] = {(char)ks[i].key, 0};
    chip(8 + (i % 2) * 116, 24 + (i / 2) * 20, ks[i].key, kn, ks[i].name, have, false);
  }
  sendBar(20, 90, 200, 6, now);
  char s[64];
  const char* sl = sentLine(now, s, sizeof(s));
  text(sl ? sl : "f full  o off  ` back", 6, 104, F12, sl ? kVolt : kDim);
  spikeMsg(121);
}

void drawSpike(uint32_t now) {
  switch (spike::P.stage) {
    case spike::Stage::Home: drawSpikeHome(now); break;
    case spike::Stage::CandReady:
    case spike::Stage::CandAsk:
    case spike::Stage::ConfReady:
    case spike::Stage::ConfAsk:
    case spike::Stage::CandHit:
    case spike::Stage::CandDone: drawSpikeCand(now); break;
    case spike::Stage::LearnWait:
    case spike::Stage::LearnAgain: drawSpikeLearn(now); break;
    case spike::Stage::ReplayReady:
    case spike::Stage::ReplayAsk: drawSpikeReplay(now); break;
    case spike::Stage::ReplayDone: drawSpikeDone(now); break;
    case spike::Stage::Remote: drawSpikeRemote(now); break;
  }
}

bool animating(uint32_t now) {
  const app::State& S = app::S;
  if (S.mode == app::Mode::Boot || S.mode == app::Mode::Pair || S.mode == app::Mode::Learn) return true;
  if (S.fx.at && now - S.fx.at < 1600) return true;
  if ((int32_t)(S.fx.litUntil - now) > -100) return true;
  if (S.cap.at && now - S.cap.at < 400) return true;
  if (S.overlay.active) return true;
  if (S.menu.hot >= 0 && now - S.menu.hotAt < 400) return true;
  if (spike::P.msgAt && now - spike::P.msgAt < 100) return true;
  return false;
}

void render(uint32_t now) {
  if (!canvasOk) return;
  canvas.fillScreen(kBg);
  switch (app::S.mode) {
    case app::Mode::Boot: drawBoot(now); break;
    case app::Mode::Idle: drawIdle(now); break;
    case app::Mode::Pair: drawPair(now); break;
    case app::Mode::Menu: drawMenu(now); break;
    case app::Mode::Learn: drawLearn(now); break;
    case app::Mode::Spike: drawSpike(now); break;
    case app::Mode::Word: drawWord(now); break;
  }
  if (app::S.mode != app::Mode::Word && app::S.mode != app::Mode::Pair) beam(now);
  drawOverlay(now);
  canvas.pushSprite(0, 0);
}

}  // namespace

void begin() {
  M5.Display.setRotation(1);
  M5.Display.setBrightness(180);
  M5.Display.fillScreen(kBg);
  canvas.setColorDepth(16);
  canvasOk = canvas.createSprite(W, H) != nullptr;
  canvas.setTextWrap(false);
  dirty_ = true;
}

void dirty() { dirty_ = true; }

void frame() {
  const uint32_t now = millis();
  if (now - lastFrame < 33) return;
  if (!dirty_ && !animating(now)) return;
  lastFrame = now;
  dirty_ = false;
  render(now);
}

void renderNow() {
  const uint32_t now = millis();
  lastFrame = now;
  dirty_ = false;
  render(now);
}

}  // namespace ui
