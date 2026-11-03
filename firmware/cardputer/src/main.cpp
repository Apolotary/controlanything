// ControlAnything IR node: firmware for the M5Stack Cardputer and Cardputer-Adv.
//
// The Mac companion drives it over USB serial (JSON lines, see proto.h and README.md):
// IR sends with acks, IR learning through an IR receiver on Grove, a pairing QR, and a
// hack menu whose keys report back as picks. Without a host it runs the G1 spike
// (spike.h) so the ceiling light can be tested on its own.
#include <M5Cardputer.h>
#include <esp_mac.h>

#include "app.h"
#include "config.h"
#include "ir_node.h"
#include "keys.h"
#include "proto.h"
#include "spike.h"
#include "store.h"
#include "ui.h"

using app::Mode;
using app::S;

namespace {

void onPreSend(const irnode::Meta& m) {
  const uint32_t now = millis();
  S.fx.sending = true;
  snprintf(S.fx.line, sizeof(S.fx.line), "%s", m.label);
  S.fx.step = m.step;
  S.fx.of = m.of;
  S.fx.phase = m.phase;
  // The flash may turn on at most once a second; if it is already lit it stays lit.
  const bool lit = (int32_t)(S.fx.litUntil - now) > 0;
  if (lit || now - S.fx.lastOnAt >= cfg::kFlashMinIntervalMs) {
    if (!lit) S.fx.lastOnAt = now;
    S.fx.litUntil = now + 60000;  // until the send ends
  }
  ui::renderNow();
}

void handleDone() {
  irnode::Done d;
  if (!irnode::takeDone(d)) return;
  const uint32_t now = millis();
  S.fx.sending = false;
  S.fx.at = now;
  if ((int32_t)(S.fx.litUntil - now) > 0) S.fx.litUntil = now + cfg::kFlashOnMs;
  snprintf(S.lastCmd, sizeof(S.lastCmd), "%s", d.meta.label);
  S.lastCmdAt = now;
  if (d.meta.id[0]) proto::emitIrAck(d.meta.id, d.ok, d.sentMs, d.count, d.err);
  ui::dirty();
}

void handleCapture() {
  if (!irnode::rxActive()) return;
  bool cut = false;
  const size_t n = irnode::rxPoll(S.cap.us, cfg::kLearnMaxEntries, &cut);
  if (!n) return;
  S.cap.n = (uint16_t)n;
  S.cap.truncated = cut;
  S.cap.a = ir::analyze(S.cap.us, n);
  ir::describe(S.cap.a, S.cap.desc, sizeof(S.cap.desc));
  S.cap.at = millis();
  ui::dirty();
  if (S.mode == Mode::Spike) {
    spike::onCapture();
    return;
  }
  if (S.learn.on) {
    S.learn.frames++;
    bool stored = false;
    if (S.learn.slot[0]) stored = app::storeCapture(S.learn.slot, S.learn.label);
    S.learn.stored = S.learn.stored || stored;
    proto::emitLearned(nullptr, S.learn.slot, S.learn.label, stored);
  } else {
    proto::emitLearned(nullptr, nullptr, nullptr, false);
  }
}

void handleLearnTimeout() {
  if (!S.learn.on) return;
  if ((int32_t)(millis() - S.learn.deadline) < 0) return;
  const uint16_t frames = S.learn.frames;
  S.learn.on = false;
  irnode::rxStop();
  proto::emitLearnEnd(frames, "timeout");
  if (S.mode == Mode::Learn) app::enterMode(S.before);
}

void toggleTx() {
  const uint8_t tx = irnode::defaultTx() == irnode::kTxLed ? irnode::kTxGrove : irnode::kTxLed;
  irnode::setDefaultTx(tx);
  store::setTxPin(tx);
  ui::dirty();
}

void onMenuKey(const keys::Press& p, const char* kname) {
  app::Menu& M = S.menu;
  for (uint8_t i = 0; i < M.nItems; i++) {
    app::MenuItem& it = M.items[i];
    if (!keys::matches(p, it.key)) continue;
    if (!it.armed) return;  // disarmed hacks cannot be picked
    M.hot = (int8_t)i;
    M.hotAt = millis();
    bool fired = false;
    if (M.local && it.slot[0]) fired = app::fireSlot(it.slot, irnode::kPhaseLocal, -1, -1, it.label);
    proto::emitPick(it.id, kname, fired);
    ui::dirty();
    return;
  }
  if (p.key == '`' || p.key == keys::kEsc) app::enterMode(Mode::Idle);
}

void onKey(const keys::Press& p) {
  char kname[12];
  keys::name(p, kname, sizeof(kname));
  proto::emitKey(kname);
  const uint8_t k = p.key;
  const bool back = k == '`' || k == keys::kEsc;
  switch (S.mode) {
    case Mode::Boot:
      if (k == 's') {
        app::enterMode(Mode::Spike);
      } else if (k == 'l') {
        app::enterMode(Mode::Spike);
        keys::Press one{};
        one.key = '1';
        one.base = '1';
        spike::onKey(one);
      } else {
        app::enterMode(S.menu.valid ? Mode::Menu : Mode::Idle);
      }
      break;
    case Mode::Idle:
      if (k == 's') {
        app::enterMode(Mode::Spike);
      } else if (k == 'l') {
        app::enterMode(Mode::Spike);
        keys::Press one{};
        one.key = '1';
        one.base = '1';
        spike::onKey(one);
      } else if (k == 'h' && S.menu.valid) {
        app::enterMode(Mode::Menu);
      } else if (k == 'p') {
        if (S.pair.stage == app::kPairPending) {
          app::enterMode(Mode::Pair);
        } else {
          proto::emitPairRequest();
        }
      } else if (k == 't') {
        toggleTx();
      }
      break;
    case Mode::Pair:
      if (k == 'c') {
        S.pair.codeOnly = !S.pair.codeOnly;
        ui::dirty();
      } else if (back) {
        app::enterMode(S.before == Mode::Pair ? Mode::Idle : S.before);
      }
      break;
    case Mode::Menu:
      onMenuKey(p, kname);
      break;
    case Mode::Learn:
      if (back) {
        const uint16_t frames = S.learn.frames;
        S.learn.on = false;
        irnode::rxStop();
        proto::emitLearnEnd(frames, "user");
        app::enterMode(S.before);
      }
      break;
    case Mode::Spike:
      spike::onKey(p);
      ui::dirty();
      break;
    case Mode::Word:
      S.word.active = false;
      app::enterMode(S.before);
      break;
  }
}

void tickModes() {
  const uint32_t now = millis();
  if (S.mode == Mode::Boot && now - S.bootAt >= cfg::kBootWindowMs) {
    app::enterMode(S.menu.valid ? Mode::Menu : Mode::Idle);
  }
  if (S.mode == Mode::Word && S.word.active && (int32_t)(now - S.word.until) >= 0) {
    S.word.active = false;
    app::enterMode(S.before);
  }
  if (S.overlay.active && (int32_t)(now - S.overlay.until) >= 0) {
    S.overlay.active = false;
    ui::dirty();
  }
  if (S.mode == Mode::Pair) {
    app::Pair& P = S.pair;
    const bool result = P.stage == app::kPairApproved || P.stage == app::kPairLinked ||
                        P.stage == app::kPairDenied || P.stage == app::kPairExpired;
    if (result && now - P.stageAt > 2500) {
      if (P.stage != app::kPairApproved && P.stage != app::kPairLinked) P.stage = app::kPairNone;
      app::enterMode(S.menu.valid ? Mode::Menu : Mode::Idle);
    } else if (P.stage == app::kPairPending && (int32_t)(now - P.expiresAt) >= 0) {
      P.stage = app::kPairExpired;
      P.stageAt = now;
      ui::dirty();
    }
  }
}

void makeChipId(char* buf, size_t cap) {
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  snprintf(buf, cap, "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

}  // namespace

void setup() {
  proto::begin();  // Serial buffers must be sized before the port starts

  auto c = M5.config();
  c.serial_baudrate = 0;   // proto::begin() owns Serial
  c.internal_imu = false;
  c.internal_mic = false;  // on the original Cardputer the mic shares G43 with the speaker
  c.internal_spk = true;
  c.fallback_board = CE_TARGET_ADV ? m5::board_t::board_M5CardputerADV : m5::board_t::board_M5Cardputer;
  M5Cardputer.begin(c, false);  // keyboard set up below with the reader for this board

  const auto board = M5.getBoard();
  S.adv = board == m5::board_t::board_M5CardputerADV;
  snprintf(S.board, sizeof(S.board), "%s", S.adv ? "cardputer-adv" : "cardputer");
  makeChipId(S.chip, sizeof(S.chip));
  S.bootAt = millis();

  keys::begin(S.adv);
  store::begin();
  irnode::begin(store::txPin());
  irnode::setPreSendHook(onPreSend);
  M5.Speaker.setVolume(96);
  ui::begin();
  proto::restoreMenu();

  S.mode = Mode::Boot;
  ui::renderNow();
  proto::emitHello(nullptr);
  char msg[64];
  snprintf(msg, sizeof(msg), "boot %s fw %s codes %d", S.board, CE_FW_VERSION, store::slotCount());
  proto::emitLog("info", msg);
}

void loop() {
  M5Cardputer.update();
  keys::Press presses[8];
  const int n = keys::poll(presses, 8);
  for (int i = 0; i < n; i++) onKey(presses[i]);

  proto::poll();
  irnode::poll();
  handleDone();
  handleCapture();
  handleLearnTimeout();
  tickModes();
  ui::frame();
  delay(1);
}
