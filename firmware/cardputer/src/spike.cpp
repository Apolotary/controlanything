#include "spike.h"

#include <Arduino.h>
#include <string.h>

#include "app.h"
#include "candidates.h"
#include "proto.h"
#include "store.h"

namespace spike {

State P;

namespace {

uint16_t firstUs[cfg::kLearnMaxEntries];
uint16_t firstN = 0;

void say(const char* fmt, const char* a = "", const char* b = "") {
  snprintf(P.msg, sizeof(P.msg), fmt, a, b);
  P.msgAt = millis();
}

const char* txName() { return irnode::defaultTx() == irnode::kTxGrove ? "grove" : "led"; }

bool fireCand(int idx, bool confirm) {
  const cand::Candidate& c = cand::kList[idx];
  irnode::Meta m;
  snprintf(m.label, sizeof(m.label), "%s %s", c.brand, confirm ? c.confirmWhat : c.what);
  m.phase = irnode::kPhaseTry;
  m.step = (int16_t)(idx + 1);
  m.of = (int16_t)cand::kCount;
  m.tx = irnode::defaultTx();
  const char* err = nullptr;
  const bool ok = app::fireBytes(cand::fmtName(c.fmt), c.unitUs, confirm ? c.confirmBytes : c.bytes, c.repeats,
                                 c.gapMs, m, &err);
  if (!ok) say("not sent: %s", err ? err : "busy");
  return ok;
}

void logCand(int idx, bool confirm, char ans) {
  const cand::Candidate& c = cand::kList[idx];
  proto::emitSpikeCand(c.id, confirm ? "confirm" : "main", confirm ? c.confirmBytes : c.bytes,
                       cand::fmtName(c.fmt), ans, txName());
}

int slotIndexFor(int replayIdx, store::SlotInfo& si) { return store::slotAt(replayIdx, si) ? replayIdx : -1; }

bool fireReplay() {
  store::SlotInfo si;
  if (slotIndexFor(P.replayIdx, si) < 0) return false;
  char label[40];
  snprintf(label, sizeof(label), "#%d %s", P.replayIdx + 1, si.name);
  return app::fireSlot(si.name, irnode::kPhaseReplay, (int16_t)(P.replayIdx + 1), (int16_t)store::slotCount(),
                       label);
}

void startLearn() {
  P.learnIdx = 0;
  P.haveFirst = false;
  P.stage = Stage::LearnWait;
  irnode::rxStart();
  say("listening on Grove G1");
}

void nextLearn() {
  P.learnIdx++;
  P.haveFirst = false;
  if (P.learnIdx >= cand::kLearnCount) {
    irnode::rxStop();
    P.replayIdx = 0;
    P.stage = store::slotCount() ? Stage::ReplayReady : Stage::Home;
    say(store::slotCount() ? "now replay each at the lamp" : "nothing learned");
  } else {
    P.stage = Stage::LearnWait;
  }
}

void keepFirst() {
  const cand::LearnButton& b = cand::kLearnButtons[P.learnIdx];
  // Re-load the first capture into the shared capture buffer so storeCapture() keeps it.
  memcpy(app::S.cap.us, firstUs, firstN * sizeof(uint16_t));
  app::S.cap.n = firstN;
  app::S.cap.a = ir::analyze(firstUs, firstN);
  ir::describe(app::S.cap.a, app::S.cap.desc, sizeof(app::S.cap.desc));
  if (app::storeCapture(b.slot, b.ja)) {
    say("saved %s", b.slot);
    proto::emitLearned(nullptr, b.slot, b.ja, true);
  } else {
    say("NVS full: %s not saved", b.slot);
  }
  nextLearn();
}

}  // namespace

bool wantsRx() { return P.stage == Stage::LearnWait || P.stage == Stage::LearnAgain; }

void enter() {
  P = State();
  P.stage = Stage::Home;
  say("lamp ON first, aim at it");
}

void leave() {
  irnode::rxStop();
  P.stage = Stage::Home;
}

void onCapture() {
  if (!wantsRx()) return;
  const cand::LearnButton& b = cand::kLearnButtons[P.learnIdx];
  if (!P.haveFirst) {
    memcpy(firstUs, app::S.cap.us, app::S.cap.n * sizeof(uint16_t));
    firstN = app::S.cap.n;
    P.haveFirst = true;
    P.stage = Stage::LearnAgain;
    say("got it: press it again");
    proto::emitLearned(nullptr, nullptr, b.ja, false);
    return;
  }
  if (ir::sameCode(firstUs, firstN, app::S.cap.us, app::S.cap.n)) {
    keepFirst();
  } else {
    memcpy(firstUs, app::S.cap.us, app::S.cap.n * sizeof(uint16_t));
    firstN = app::S.cap.n;
    say("no match: press it again");
    proto::emitLearned(nullptr, nullptr, b.ja, false);
  }
}

void onKey(const keys::Press& p) {
  const uint8_t k = p.key;
  const uint8_t arrow = keys::arrow(p);
  const bool back = k == '`' || k == keys::kEsc;
  const bool go = k == keys::kEnter || k == ' ';

  if (k == 't' && (P.stage == Stage::Home || P.stage == Stage::CandReady || P.stage == Stage::ReplayReady ||
                   P.stage == Stage::Remote)) {
    const uint8_t tx = irnode::defaultTx() == irnode::kTxLed ? irnode::kTxGrove : irnode::kTxLed;
    irnode::setDefaultTx(tx);
    store::setTxPin(tx);
    say(tx == irnode::kTxGrove ? "TX: IR Unit LED (Grove G2)" : "TX: built-in LED (G44)");
    return;
  }

  switch (P.stage) {
    case Stage::Home:
      if (k == '1' || k == 'l') {
        startLearn();
      } else if (k == '2' || k == 'c') {
        P.cand = 0;
        P.stage = Stage::CandReady;
        say("lamp ON first, Enter fires");
      } else if (k == '3' || k == 'r') {
        if (store::slotCount()) {
          P.replayIdx = 0;
          P.stage = Stage::ReplayReady;
        } else {
          say("no learned codes yet (1 = learn)");
        }
      } else if (k == '4' || k == 'h') {
        if (store::slotCount()) {
          P.stage = Stage::Remote;
        } else {
          say("no learned codes yet (1 = learn)");
        }
      } else if (back) {
        app::enterMode(app::Mode::Idle);
      }
      break;

    case Stage::CandReady:
      if (go) {
        if (fireCand(P.cand, false)) P.stage = Stage::CandAsk;
      } else if (arrow == keys::kLeft || arrow == keys::kUp) {
        P.cand = (P.cand + cand::kCount - 1) % cand::kCount;
      } else if (arrow == keys::kRight || arrow == keys::kDown || k == keys::kTab) {
        P.cand = (P.cand + 1) % cand::kCount;
      } else if (back) {
        P.stage = Stage::Home;
      }
      break;

    case Stage::CandAsk:
      if (k == 'y') {
        store::putAnswer(cand::kList[P.cand].id, 0, 'y');
        logCand(P.cand, false, 'y');
        P.stage = Stage::ConfReady;
        say("Enter: confirm with %s", cand::kList[P.cand].confirmWhat);
      } else if (k == 'n') {
        store::putAnswer(cand::kList[P.cand].id, 0, 'n');
        logCand(P.cand, false, 'n');
        if (P.cand + 1 >= cand::kCount) {
          P.stage = Stage::CandDone;
        } else {
          P.cand++;
          P.stage = Stage::CandReady;
        }
      } else if (k == 'r') {
        fireCand(P.cand, false);
      } else if (back) {
        P.stage = Stage::CandReady;
      }
      break;

    case Stage::ConfReady:
      if (go) {
        if (fireCand(P.cand, true)) P.stage = Stage::ConfAsk;
      } else if (back || k == keys::kTab) {
        P.stage = Stage::CandHit;
        P.lastConfirmOk = false;
      }
      break;

    case Stage::ConfAsk:
      if (k == 'y' || k == 'n') {
        store::putAnswer(cand::kList[P.cand].id, 1, (char)k);
        logCand(P.cand, true, (char)k);
        P.lastConfirmOk = k == 'y';
        P.hits++;
        P.stage = Stage::CandHit;
      } else if (k == 'r') {
        fireCand(P.cand, true);
      }
      break;

    case Stage::CandHit:
      if (go) {
        if (P.cand + 1 >= cand::kCount) {
          P.stage = Stage::CandDone;
        } else {
          P.cand++;
          P.stage = Stage::CandReady;
        }
      } else if (back) {
        P.stage = Stage::Home;
      }
      break;

    case Stage::CandDone:
      if (go || back) P.stage = Stage::Home;
      break;

    case Stage::LearnWait:
    case Stage::LearnAgain:
      if (k == keys::kTab) {
        say("skipped %s", cand::kLearnButtons[P.learnIdx].ja);
        nextLearn();
      } else if (go && P.haveFirst) {
        keepFirst();  // keep the single capture without a second press
      } else if (k == 'r') {
        P.haveFirst = false;
        P.stage = Stage::LearnWait;
        say("retry: press %s", cand::kLearnButtons[P.learnIdx].ja);
      } else if (back) {
        irnode::rxStop();
        P.stage = Stage::Home;
      }
      break;

    case Stage::ReplayReady:
      if (go) {
        if (fireReplay()) P.stage = Stage::ReplayAsk;
      } else if (arrow == keys::kLeft || arrow == keys::kUp) {
        const int n = store::slotCount();
        if (n) P.replayIdx = (P.replayIdx + n - 1) % n;
      } else if (arrow == keys::kRight || arrow == keys::kDown || k == keys::kTab) {
        const int n = store::slotCount();
        if (n) P.replayIdx = (P.replayIdx + 1) % n;
      } else if (back) {
        P.stage = Stage::Home;
      }
      break;

    case Stage::ReplayAsk:
      if (k == 'y' || k == 'n') {
        store::SlotInfo si;
        if (store::slotAt(P.replayIdx, si)) {
          store::setVerified(si.name, k == 'y' ? 1 : 2);
          proto::emitSpikeReplay(si.name, si.label, (char)k, txName());
        }
        if (P.replayIdx + 1 >= store::slotCount()) {
          P.stage = Stage::ReplayDone;
        } else {
          P.replayIdx++;
          P.stage = Stage::ReplayReady;
        }
      } else if (k == 'r') {
        fireReplay();
      } else if (back) {
        P.stage = Stage::ReplayReady;
      }
      break;

    case Stage::ReplayDone:
      if (go) {
        P.stage = Stage::Remote;
      } else if (back) {
        P.stage = Stage::Home;
      }
      break;

    case Stage::Remote: {
      const char* slot = nullptr;
      if (k == keys::kEnter || k == ' ') {
        slot = P.remoteOn ? "full" : "off";
        if (store::findSlot(slot) < 0) slot = P.remoteOn ? "off" : "full";
        P.remoteOn = !P.remoteOn;
      } else if (arrow == keys::kLeft) {
        slot = "darker";
      } else if (arrow == keys::kRight) {
        slot = "brighter";
      } else if (arrow == keys::kUp) {
        slot = "warmer";
      } else if (arrow == keys::kDown) {
        slot = "cooler";
      } else if (k == 'n') {
        slot = "night";
      } else if (k == 'f') {
        slot = "full";
      } else if (k == 'o') {
        slot = "off";
      } else if (back) {
        P.stage = Stage::Home;
      }
      if (slot) {
        if (store::findSlot(slot) < 0) {
          say("%s was not learned", slot);
        } else if (!app::fireSlot(slot, irnode::kPhaseLocal, -1, -1, slot)) {
          say("busy");
        }
      }
      break;
    }
  }
}

}  // namespace spike
