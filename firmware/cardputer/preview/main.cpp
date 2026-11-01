// Renders every screen of src/ui.cpp to preview/out/*.png on the Mac (no board needed).
//   sh preview/build.sh && open preview/out
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "preview_shim.h"
#include "../src/app.h"
#include "../src/ir_codec.h"
#include "../src/spike.h"
#include "../src/ui.h"

extern uint32_t g_now;
namespace store { void fakeSlots(int n); }

static void save(const char* name) {
  ui::renderNow();
  size_t len = 0;
  void* png = M5.Display.createPng(&len, 0, 0, 240, 135);
  char path[256];
  snprintf(path, sizeof(path), "preview/out/%s.png", name);
  FILE* f = fopen(path, "wb");
  if (f && png) {
    fwrite(png, 1, len, f);
    fclose(f);
    printf("wrote %s\n", path);
  }
  free(png);
}

static void capture() {
  uint8_t b[8];
  int n = ir::parseHex("2C 52 09 2F 26", b, 8);
  uint16_t one[200];
  size_t m = ir::encode(ir::aehaFormat(432), b, n, one, 200);
  app::Capture& c = app::S.cap;
  c.n = 0;
  for (size_t i = 0; i < m; i++) c.us[c.n++] = (uint16_t)((i & 1) ? one[i] - 60 : one[i] + 60);
  c.us[c.n++] = 65000;
  for (size_t i = 0; i < m; i++) c.us[c.n++] = (uint16_t)((i & 1) ? one[i] - 60 : one[i] + 60);
  c.a = ir::analyze(c.us, c.n);
  ir::describe(c.a, c.desc, sizeof(c.desc));
  c.at = g_now - 1000;
}

int main() {
  mkdir("preview/out", 0755);
  M5.Display.setColorDepth(16);
  M5.Display.createSprite(240, 135);
  ui::begin();
  app::State& S = app::S;
  strcpy(S.board, "cardputer");
  strcpy(S.chip, "70041DD4E5C0");
  store::fakeSlots(0);

  S.mode = app::Mode::Boot; S.bootAt = g_now - 900; save("01-boot");

  S.mode = app::Mode::Idle; save("02-idle-nohost");

  S.hostSeen = true; S.lastHostMs = g_now - 2000; strcpy(S.hostName, "companion@0.2.0");
  store::fakeSlots(5);
  strcpy(S.fx.line, "koizumi/off"); S.fx.at = g_now - 250; save("03-idle-sent-beam");
  S.fx.sending = true; S.fx.litUntil = g_now + 50; save("04-idle-sending-flash");
  S.fx.sending = false; S.fx.litUntil = 0; S.fx.at = 0; strcpy(S.lastCmd, "NEC 82 6D BE 41");

  S.mode = app::Mode::Pair;
  S.pair.stage = app::kPairPending;
  strcpy(S.pair.qr, "https://192.168.1.20:8443/p/pr_8f3k2m9q1x7z4c6v#K7Q4M2");
  strcpy(S.pair.code, "K7Q4M2"); strcpy(S.pair.display, "K7Q-4M2");
  S.pair.expiresAt = g_now + 287000; save("05-pair-url");
  strcpy(S.pair.qr, "CE1:K7Q4M2"); save("06-pair-short");
  S.pair.codeOnly = true; save("07-pair-code-only");
  S.pair.codeOnly = false; S.pair.stage = app::kPairApproved; strcpy(S.pair.name, "MacBook"); save("08-pair-linked");

  S.mode = app::Mode::Menu;
  app::Menu& M = S.menu;
  M = app::Menu(); M.valid = true; strcpy(M.title, "CEILING LIGHT");
  struct It { const char* id; const char* key; uint8_t code; const char* label; bool armed; };
  It items[] = {{"dim", "left", keys::kLeft, "dim", true}, {"bright", "right", keys::kRight, "bright", true},
                {"warm", "up", keys::kUp, "warm", true}, {"cool", "down", keys::kDown, "cool", true},
                {"power", "enter", keys::kEnter, "on/off", true}, {"night", "n", 'n', "night", false}};
  for (auto& it : items) {
    app::MenuItem& mi = M.items[M.nItems++];
    strcpy(mi.id, it.id); strcpy(mi.keyName, it.key); mi.key = it.code; strcpy(mi.label, it.label); mi.armed = it.armed;
  }
  app::MenuBar& b0 = M.bars[M.nBars++]; strcpy(b0.id, "bright"); strcpy(b0.label, "BRIGHT"); strcpy(b0.unit, "%"); b0.value = 0.4f; b0.big = true;
  app::MenuBar& b1 = M.bars[M.nBars++]; strcpy(b1.id, "warmth"); strcpy(b1.label, "WARMTH"); strcpy(b1.lo, "WARM"); strcpy(b1.hi, "COOL"); b1.value = 0.6f; b1.steps = 5;
  M.hot = 1; M.hotAt = g_now - 100; save("09-hacks");
  M.hot = -1;
  M.nBars = 0; save("10-hacks-list");

  S.mode = app::Mode::Learn;
  S.learn.on = true; strcpy(S.learn.label, "常夜灯"); S.learn.step = 3; S.learn.of = 7; S.learn.deadline = g_now + 23000;
  S.cap.n = 0; save("11-learn-waiting");
  capture(); save("12-learn-captured");

  S.mode = app::Mode::Word; S.word.active = true; strcpy(S.word.text, "ONLINE"); save("13-word");

  S.mode = app::Mode::Idle;
  S.overlay = app::Overlay(); S.overlay.active = true; strcpy(S.overlay.title, "UPLOADING");
  strcpy(S.overlay.text, "SENT OK / SEEN BRIGHTER"); S.overlay.progress = 0.5f; S.overlay.tone = 1; S.overlay.until = g_now + 1000;
  save("14-show-overlay");
  S.overlay.active = false;

  S.mode = app::Mode::Spike;
  spike::P = spike::State(); strcpy(spike::P.msg, "lamp ON first, aim at it"); save("15-spike-home");
  spike::P.stage = spike::Stage::CandReady; spike::P.cand = 0; spike::P.msg[0] = 0; save("16-spike-cand");
  spike::P.stage = spike::Stage::CandAsk; strcpy(S.fx.line, "Panasonic OFF"); S.fx.at = g_now - 400; save("17-spike-ask");
  S.fx.at = 0;
  spike::P.stage = spike::Stage::LearnAgain; spike::P.learnIdx = 2; strcpy(spike::P.msg, "got it: press it again"); save("18-spike-learn");
  spike::P.stage = spike::Stage::ReplayReady; spike::P.replayIdx = 1; spike::P.msg[0] = 0; save("19-spike-replay");
  store::fakeSlots(7);
  spike::P.stage = spike::Stage::ReplayDone; save("20-spike-result");
  spike::P.stage = spike::Stage::Remote; save("21-spike-remote");
  return 0;
}
