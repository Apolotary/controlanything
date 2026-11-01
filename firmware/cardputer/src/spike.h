// Standalone G1 spike: test the ceiling light with no host software.
//
//   1 LEARN + REPLAY  needs an IR receiver on Grove (M5 IR Unit): learn each remote
//                     button twice, replay each at the light, answer y/n, keep it in NVS.
//   2 CANDIDATES      no receiver: cycle other makers' OFF codes (CH1-CH3), y/n, confirm
//                     a hit with the matching ON code, keep the answers in NVS.
//   3 REPLAY          replay what is stored.
//   4 REMOTE          use the learned codes as a remote (arrows dim/brighten, Enter on/off).
// Every answer is also logged to serial as {"t":"spike",...}.
#pragma once
#include <stdint.h>

#include "keys.h"

namespace spike {

enum class Stage : uint8_t {
  Home,
  CandReady,
  CandAsk,
  ConfReady,
  ConfAsk,
  CandHit,
  CandDone,
  LearnWait,
  LearnAgain,
  ReplayReady,
  ReplayAsk,
  ReplayDone,
  Remote,
};

struct State {
  Stage stage = Stage::Home;
  int cand = 0;
  int learnIdx = 0;
  int replayIdx = 0;
  int hits = 0;
  bool haveFirst = false;
  bool lastConfirmOk = false;
  char msg[64] = {0};
  uint32_t msgAt = 0;
  bool remoteOn = true;    // what Enter toggles to next in REMOTE
};

extern State P;

void enter();
void leave();
void onKey(const keys::Press& p);
// A fresh capture is in app::S.cap.
void onCapture();
// The stage needs the receiver?
bool wantsRx();

}  // namespace spike
