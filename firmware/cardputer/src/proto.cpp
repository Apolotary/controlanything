#include "proto.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <M5Unified.h>
#include <string.h>
#include <strings.h>

#include "app.h"
#include "candidates.h"
#include "config.h"
#include "ir_codec.h"
#include "ir_node.h"
#include "keys.h"
#include "store.h"

namespace proto {
namespace {

char line[cfg::kLineMax + 1];
size_t lineLen = 0;
bool discarding = false;
char out[cfg::kOutMax + 8];
uint16_t usBuf[cfg::kIrMaxEntries];

// Beeps: at most 4 pips, at most one per second (photosensitivity rules apply to sound cues too).
uint8_t beepsLeft = 0;
uint32_t nextBeepAt = 0;
uint16_t beepHz = 3000, beepMs = 60;

void writeLine(size_t n) {
  if (n == 0 || n > cfg::kOutMax) return;
  out[n] = '\n';
  // Never block the UI: drop the line if the host is not draining the buffer.
  if (Serial.availableForWrite() < (int)(n + 1)) return;
  Serial.write((const uint8_t*)out, n + 1);
}

void writeDoc(JsonDocument& doc) {
  const size_t n = serializeJson(doc, out, cfg::kOutMax);
  writeLine(n);
}

void copyStr(char* dst, size_t cap, const char* src) {
  if (!cap) return;
  if (!src) src = "";
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = 0;
}

void idOf(JsonDocument& doc, char* id, size_t cap) {
  JsonVariant v = doc["id"];
  if (v.is<const char*>()) {
    copyStr(id, cap, v.as<const char*>());
  } else if (v.is<long>()) {
    snprintf(id, cap, "%ld", v.as<long>());
  } else {
    id[0] = 0;
  }
}

uint8_t phaseOf(const char* s) {
  if (!s) return irnode::kPhaseHack;
  if (!strcmp(s, "try")) return irnode::kPhaseTry;
  if (!strcmp(s, "replay")) return irnode::kPhaseReplay;
  return irnode::kPhaseHack;
}

void fillMeta(JsonDocument& doc, irnode::Meta& m, const char* id) {
  copyStr(m.id, sizeof(m.id), id);
  copyStr(m.label, sizeof(m.label), doc["label"] | "");
  m.step = doc["step"] | -1;
  m.of = doc["of"] | -1;
  m.phase = phaseOf(doc["phase"] | (const char*)nullptr);
  const char* tx = doc["tx"] | (const char*)nullptr;
  m.tx = tx ? (strcmp(tx, "grove") == 0 ? irnode::kTxGrove : irnode::kTxLed) : irnode::defaultTx();
  m.khz = (uint8_t)(doc["khz"] | (int)cfg::kIrDefaultKhz);
  m.repeats = (uint8_t)(doc["repeats"] | 0);
  if (doc["gapMs"].is<int>()) {
    m.gapMs = (uint16_t)(doc["gapMs"].as<int>());
  } else if (doc["frameGapUs"].is<long>()) {
    m.gapMs = (uint16_t)((doc["frameGapUs"].as<long>() + 500) / 1000);
  } else {
    m.gapMs = 40;
  }
}

// ---- commands -------------------------------------------------------------------------

void cmdIr(JsonDocument& doc, const char* id) {
  if (irnode::busy()) {
    emitAck(id, false, "busy", "an IR send is already pending");
    return;
  }
  irnode::Meta m;
  fillMeta(doc, m, id);
  // Bounds on the numbers before they are narrowed.
  const int khz = doc["khz"] | (int)cfg::kIrDefaultKhz;
  const int rep = doc["repeats"] | 0;
  if (khz < 30 || khz > 60 || rep < 0 || rep > cfg::kIrMaxRepeats) {
    emitAck(id, false, "bad_args", "khz 30..60, repeats 0..5");
    return;
  }

  JsonArray arr = doc["us"].is<JsonArray>() ? doc["us"].as<JsonArray>() : doc["rawUs"].as<JsonArray>();
  const char* slot = doc["slot"] | (const char*)nullptr;
  const char* candId = doc["cand"] | (const char*)nullptr;
  const char* bytes = doc["bytes"] | (const char*)nullptr;
  const char* protocol = doc["protocol"] | (const char*)nullptr;

  if (!arr.isNull()) {
    const size_t n = arr.size();
    if (n < 2 || n > cfg::kIrMaxEntries) {
      emitAck(id, false, "bad_args", "us: 2..1024 entries");
      return;
    }
    size_t i = 0;
    for (JsonVariant v : arr) {
      const long x = v.is<long>() ? v.as<long>() : (v.is<float>() ? (long)(v.as<float>() + 0.5f) : -1L);
      if (x < 1 || x > 65000) {
        emitAck(id, false, "bad_args", "us entries must be 1..65000");
        return;
      }
      usBuf[i++] = (uint16_t)x;
    }
    const char* err = irnode::validate(usBuf, n, m);
    if (err) {
      emitAck(id, false, err, "frame too long or bad gap");
      return;
    }
    if (!m.label[0]) snprintf(m.label, sizeof(m.label), "RAW %u", (unsigned)((n + 1) / 2));
    irnode::submit(m, usBuf, n);
    return;  // ack when it has left the LED
  }

  if (slot) {
    store::SlotInfo si;
    const int n = store::loadSlot(slot, usBuf, cfg::kIrMaxEntries, &si);
    if (n < 0) {
      emitAck(id, false, "bad_args", "no such slot");
      return;
    }
    if (!doc["khz"].is<int>()) m.khz = si.khz ? si.khz : 38;
    if (!doc["repeats"].is<int>()) {
      m.repeats = si.repeats;
      m.gapMs = si.gapMs;
    }
    if (!m.label[0]) copyStr(m.label, sizeof(m.label), si.name);
    const char* err = irnode::validate(usBuf, (size_t)n, m);
    if (err) {
      emitAck(id, false, err, "stored code invalid");
      return;
    }
    irnode::submit(m, usBuf, (size_t)n);
    return;
  }

  if (candId) {
    const int ci = cand::find(candId);
    if (ci < 0) {
      emitAck(id, false, "bad_args", "no such candidate");
      return;
    }
    const cand::Candidate& c = cand::kList[ci];
    const bool confirm = strcmp(doc["part"] | "main", "confirm") == 0;
    if (!m.label[0]) snprintf(m.label, sizeof(m.label), "%s %s", c.brand, confirm ? c.confirmWhat : c.what);
    if (m.step < 0) {
      m.step = (int16_t)(ci + 1);
      m.of = (int16_t)cand::kCount;
      m.phase = irnode::kPhaseTry;
    }
    const char* err = nullptr;
    if (!app::fireBytes(cand::fmtName(c.fmt), c.unitUs, confirm ? c.confirmBytes : c.bytes, c.repeats, c.gapMs, m,
                        &err)) {
      emitAck(id, false, err ? err : "bad_args", "candidate not sent");
    }
    return;
  }

  char necHex[16];
  if (!bytes && protocol && !strcasecmp(protocol, "NEC") && doc["address"].is<long>() && doc["command"].is<long>()) {
    const long addr = doc["address"].as<long>(), cmd = doc["command"].as<long>();
    if (addr < 0 || addr > 0xFFFF || cmd < 0 || cmd > 0xFF) {
      emitAck(id, false, "bad_args", "NEC address 0..FFFF, command 0..FF");
      return;
    }
    const uint8_t a0 = (uint8_t)(addr & 0xFF), a1 = addr > 0xFF ? (uint8_t)(addr >> 8) : (uint8_t)~a0;
    snprintf(necHex, sizeof(necHex), "%02X %02X %02X %02X", a0, a1, (unsigned)cmd, (unsigned)(uint8_t)~cmd);
    bytes = necHex;
  }
  if (bytes && protocol) {
    const int unit = doc["unitUs"] | 425;
    const char* err = nullptr;
    if (!m.label[0]) snprintf(m.label, sizeof(m.label), "%s %s", protocol, bytes);
    if (!app::fireBytes(protocol, (uint16_t)unit, bytes, m.repeats, m.gapMs, m, &err)) {
      emitAck(id, false, err ? err : "bad_args", "protocol: NEC|AEHA|IRIS with bytes");
    }
    return;
  }
  emitAck(id, false, "bad_args", "need us, slot, cand or protocol+bytes");
}

void cmdLearn(JsonDocument& doc, const char* id) {
  const bool on = doc["on"] | true;
  app::HostLearn& L = app::S.learn;
  if (!on) {
    L.on = false;
    irnode::rxStop();
    if (app::S.mode == app::Mode::Learn) app::enterMode(app::S.before);
    emitAck(id, true);
    return;
  }
  const char* slot = doc["slot"] | "";
  if (slot[0] && !store::validName(slot)) {
    emitAck(id, false, "bad_args", "slot: [a-z0-9_-]{1,15}");
    return;
  }
  uint32_t timeout = doc["timeoutMs"] | (long)cfg::kLearnDefaultTimeoutMs;
  if (timeout < 1000) timeout = 1000;
  if (timeout > 300000) timeout = 300000;
  L.on = true;
  copyStr(L.id, sizeof(L.id), id);
  copyStr(L.label, sizeof(L.label), doc["label"] | "");
  copyStr(L.slot, sizeof(L.slot), slot);
  L.step = doc["step"] | -1;
  L.of = doc["of"] | -1;
  L.deadline = millis() + timeout;
  L.frames = 0;
  L.stored = false;
  app::S.cap.n = 0;
  irnode::rxStart();
  if (app::S.mode != app::Mode::Learn) app::enterMode(app::Mode::Learn);
  emitAck(id, true);
}

void cmdPair(JsonDocument& doc, const char* id) {
  app::Pair& P = app::S.pair;
  const char* st = doc["state"] | "pending";
  P.stageAt = millis();
  copyStr(P.name, sizeof(P.name), doc["name"] | "");
  if (!strcmp(st, "pending")) {
    const char* qr = doc["qr"] | "";
    const char* code = doc["code"] | "";
    if (!qr[0] && !code[0]) {
      emitAck(id, false, "bad_args", "pending needs qr and code");
      return;
    }
    if (strlen(qr) >= sizeof(P.qr)) {
      emitAck(id, false, "bad_args", "qr longer than 159 chars");
      return;
    }
    P.stage = app::kPairPending;
    copyStr(P.qr, sizeof(P.qr), qr);
    copyStr(P.code, sizeof(P.code), code);
    copyStr(P.display, sizeof(P.display), doc["display"] | code);
    const long ttl = doc["ttlMs"] | 300000L;
    P.expiresAt = millis() + (uint32_t)(ttl < 0 ? 0 : ttl);
    P.codeOnly = false;
    app::enterMode(app::Mode::Pair);
  } else if (!strcmp(st, "approved") || !strcmp(st, "linked")) {
    P.stage = !strcmp(st, "approved") ? app::kPairApproved : app::kPairLinked;
    if (P.name[0]) copyStr(app::S.hostName, sizeof(app::S.hostName), P.name);
    app::enterMode(app::Mode::Pair);
  } else if (!strcmp(st, "denied")) {
    P.stage = app::kPairDenied;
    app::enterMode(app::Mode::Pair);
  } else if (!strcmp(st, "expired")) {
    P.stage = app::kPairExpired;
    app::enterMode(app::Mode::Pair);
  } else {
    emitAck(id, false, "bad_args", "state: pending|approved|denied|expired|linked");
    return;
  }
  emitAck(id, true);
}

bool parseMenu(JsonDocument& doc, app::Menu& M) {
  M = app::Menu();
  copyStr(M.title, sizeof(M.title), doc["title"] | "HACKS");
  M.local = doc["local"] | false;
  JsonArray items = doc["items"].as<JsonArray>();
  for (JsonObject it : items) {
    if (M.nItems >= 12) break;
    app::MenuItem& mi = M.items[M.nItems];
    copyStr(mi.id, sizeof(mi.id), it["id"] | "");
    copyStr(mi.label, sizeof(mi.label), it["label"] | mi.id);
    copyStr(mi.keyName, sizeof(mi.keyName), it["key"] | "");
    mi.key = keys::parseName(mi.keyName);
    mi.armed = it["armed"] | true;
    copyStr(mi.slot, sizeof(mi.slot), it["slot"] | "");
    if (!mi.id[0]) continue;
    M.nItems++;
  }
  JsonArray bars = doc["bars"].as<JsonArray>();
  for (JsonObject b : bars) {
    if (M.nBars >= 3) break;
    app::MenuBar& mb = M.bars[M.nBars];
    copyStr(mb.id, sizeof(mb.id), b["id"] | "");
    copyStr(mb.label, sizeof(mb.label), b["label"] | mb.id);
    copyStr(mb.unit, sizeof(mb.unit), b["unit"] | "");
    copyStr(mb.lo, sizeof(mb.lo), b["lo"] | "");
    copyStr(mb.hi, sizeof(mb.hi), b["hi"] | "");
    float v = b["value"] | 0.0f;
    mb.value = v < 0 ? 0 : (v > 1 ? 1 : v);
    int steps = b["steps"] | 0;
    mb.steps = (uint8_t)(steps < 0 ? 0 : (steps > 10 ? 10 : steps));
    mb.big = b["big"] | false;
    M.nBars++;
  }
  M.valid = M.nItems > 0 || M.nBars > 0;
  return M.valid;
}

void cmdMenu(JsonDocument& doc, const char* id, const char* raw) {
  app::Menu M;
  if (!parseMenu(doc, M)) {
    emitAck(id, false, "bad_args", "menu needs items or bars");
    return;
  }
  app::S.menu = M;
  if (doc["persist"] | false) store::saveMenu(raw);
  app::enterMode(app::Mode::Menu);
  emitAck(id, true);
}

void cmdBar(JsonDocument& doc, const char* id) {
  const char* bar = doc["bar"] | "";
  for (uint8_t i = 0; i < app::S.menu.nBars; i++) {
    if (!strcmp(app::S.menu.bars[i].id, bar)) {
      float v = doc["value"] | 0.0f;
      app::S.menu.bars[i].value = v < 0 ? 0 : (v > 1 ? 1 : v);
      emitAck(id, true);
      return;
    }
  }
  emitAck(id, false, "bad_args", "no such bar");
}

void cmdShow(JsonDocument& doc, const char* id) {
  const bool word = strcmp(doc["style"] | "", "word") == 0;
  const long ms = doc["ms"] | 2000L;
  app::Overlay& O = word ? app::S.word : app::S.overlay;
  O = app::Overlay();
  O.active = true;
  O.word = word;
  copyStr(O.title, sizeof(O.title), doc["title"] | "");
  copyStr(O.text, sizeof(O.text), doc["text"] | "");
  O.progress = doc["progress"].is<float>() ? doc["progress"].as<float>() : -1.f;
  const char* tone = doc["tone"] | "info";
  O.tone = !strcmp(tone, "ok") ? 1 : !strcmp(tone, "warn") ? 2 : !strcmp(tone, "bad") ? 3 : 0;
  O.until = millis() + (uint32_t)(ms < 200 ? 200 : (ms > 60000 ? 60000 : ms));
  if (word) {
    if (strlen(O.text) > 8) O.text[8] = 0;
    app::enterMode(app::Mode::Word);
  }
  emitAck(id, true);
}

void cmdBeep(JsonDocument& doc, const char* id) {
  int hz = doc["hz"] | 3000;
  int ms = doc["ms"] | 60;
  int count = doc["count"] | 1;
  beepHz = (uint16_t)(hz < 2000 ? 2000 : (hz > 4000 ? 4000 : hz));
  beepMs = (uint16_t)(ms < 20 ? 20 : (ms > 200 ? 200 : ms));
  beepsLeft = (uint8_t)(count < 1 ? 1 : (count > 4 ? 4 : count));
  if ((int32_t)(nextBeepAt - millis()) < 0) nextBeepAt = millis();
  emitAck(id, true);
}

void cmdCodes(const char* id) {
  JsonDocument doc;
  doc["t"] = "ack";
  doc["id"] = id;
  doc["ok"] = true;
  JsonArray arr = doc["codes"].to<JsonArray>();
  for (int i = 0; i < store::slotCount(); i++) {
    store::SlotInfo si;
    if (!store::slotAt(i, si)) continue;
    JsonObject o = arr.add<JsonObject>();
    o["slot"] = si.name;
    o["label"] = si.label;
    o["n"] = si.count;
    o["khz"] = si.khz;
    o["protocol"] = ir::protoName((ir::Proto)si.proto);
    o["verified"] = si.verified == 1 ? "yes" : si.verified == 2 ? "no" : "untested";
  }
  writeDoc(doc);
}

void cmdCands(const char* id) {
  JsonDocument doc;
  doc["t"] = "ack";
  doc["id"] = id;
  doc["ok"] = true;
  JsonArray arr = doc["cands"].to<JsonArray>();
  for (int i = 0; i < cand::kCount; i++) {
    const cand::Candidate& c = cand::kList[i];
    JsonObject o = arr.add<JsonObject>();
    o["id"] = c.id;
    o["brand"] = c.brand;
    o["ch"] = c.ch;
    o["what"] = c.what;
    o["protocol"] = cand::fmtName(c.fmt);
    if (c.fmt == cand::Fmt::AEHA) o["unitUs"] = c.unitUs;
    o["bytes"] = c.bytes;
    o["repeats"] = c.repeats;
    o["confirm"] = c.confirmWhat;
    o["confirmBytes"] = c.confirmBytes;
    o["confidence"] = c.confidence;
    const char a = store::getAnswer(c.id, 0), b = store::getAnswer(c.id, 1);
    if (a) o["answer"] = String(a);
    if (b) o["confirmAnswer"] = String(b);
  }
  writeDoc(doc);
}

void cmdForget(JsonDocument& doc, const char* id) {
  if (doc["all"] | false) {
    store::clearSlots();
    emitAck(id, true);
    return;
  }
  if (doc["answers"] | false) {
    store::clearAnswers();
    emitAck(id, true);
    return;
  }
  const char* slot = doc["slot"] | "";
  if (store::deleteSlot(slot)) {
    emitAck(id, true);
  } else {
    emitAck(id, false, "bad_args", "no such slot");
  }
}

void cmdPanic(const char* id) {
  irnode::Meta dropped;
  if (irnode::cancel(&dropped) && dropped.id[0]) emitIrAck(dropped.id, false, millis(), 0, "cancelled");
  if (app::S.learn.on) {
    app::S.learn.on = false;
    irnode::rxStop();
  }
  beepsLeft = 0;
  app::S.overlay.active = false;
  if (app::S.mode == app::Mode::Learn || app::S.mode == app::Mode::Word) app::enterMode(app::Mode::Idle);
  emitAck(id, true);
}

void cmdMode(JsonDocument& doc, const char* id) {
  const char* m = doc["mode"] | "";
  if (!strcmp(m, "idle")) {
    app::enterMode(app::Mode::Idle);
  } else if (!strcmp(m, "spike")) {
    app::enterMode(app::Mode::Spike);
  } else if (!strcmp(m, "menu") && app::S.menu.valid) {
    app::enterMode(app::Mode::Menu);
  } else {
    emitAck(id, false, "bad_args", "mode: idle|spike|menu");
    return;
  }
  emitAck(id, true);
}

void dispatch(char* text, size_t len) {
  JsonDocument doc;
  // A const char* input is copied by ArduinoJson, so `text` stays intact for `menu` persist.
  DeserializationError e = deserializeJson(doc, (const char*)text, len);
  if (e) {
    emitAck("", false, "bad_json", e.c_str());
    return;
  }
  char id[25];
  idOf(doc, id, sizeof(id));
  const char* t = doc["t"] | "";
  app::S.lastHostMs = millis();
  app::S.hostSeen = true;

  if (!strcmp(t, "hello")) {
    const char* host = doc["host"] | "";
    if (host[0]) copyStr(app::S.hostName, sizeof(app::S.hostName), host);
    emitHello(id);
  } else if (!strcmp(t, "ir")) {
    cmdIr(doc, id);
  } else if (!strcmp(t, "learn")) {
    cmdLearn(doc, id);
  } else if (!strcmp(t, "panic")) {
    cmdPanic(id);
  } else if (!strcmp(t, "pair")) {
    cmdPair(doc, id);
  } else if (!strcmp(t, "menu") || !strcmp(t, "ui")) {
    cmdMenu(doc, id, len <= 4000 ? text : "");
  } else if (!strcmp(t, "bar")) {
    cmdBar(doc, id);
  } else if (!strcmp(t, "show")) {
    cmdShow(doc, id);
  } else if (!strcmp(t, "beep")) {
    cmdBeep(doc, id);
  } else if (!strcmp(t, "codes")) {
    cmdCodes(id);
  } else if (!strcmp(t, "cands")) {
    cmdCands(id);
  } else if (!strcmp(t, "forget")) {
    cmdForget(doc, id);
  } else if (!strcmp(t, "mode")) {
    cmdMode(doc, id);
  } else if (!strcmp(t, "ping")) {
    emitAck(id, true);
  } else if (!strcmp(t, "app")) {
    emitAck(id, false, "unsupported", "app specs are not in protocol v1");
  } else {
    emitAck(id, false, "unknown_type", t);
  }
}

}  // namespace

void begin() {
  Serial.setRxBufferSize(cfg::kLineMax + 1024);
  Serial.setTxBufferSize(8192);
  Serial.setTxTimeoutMs(0);
  Serial.begin(cfg::kSerialBaud);
}

void poll() {
  uint8_t chunk[256];
  int budget = 32;  // bound the time spent here per loop
  while (budget-- > 0) {
    const int avail = Serial.available();
    if (avail <= 0) break;
    const size_t n = Serial.read(chunk, avail > (int)sizeof(chunk) ? sizeof(chunk) : (size_t)avail);
    for (size_t i = 0; i < n; i++) {
      const char c = (char)chunk[i];
      if (c == '\n') {
        if (discarding) {
          discarding = false;
          emitAck("", false, "bad_json", "line too long");
        } else if (lineLen > 0) {
          if (line[lineLen - 1] == '\r') lineLen--;
          line[lineLen] = 0;
          size_t start = 0;
          while (start < lineLen && (line[start] == ' ' || line[start] == '\t')) start++;
          if (start < lineLen && line[start] == '{') dispatch(line + start, lineLen - start);
        }
        lineLen = 0;
      } else if (!discarding) {
        if (lineLen >= cfg::kLineMax) {
          discarding = true;
          lineLen = 0;
        } else {
          line[lineLen++] = c;
        }
      }
    }
  }

  // Beeps, paced at 1 Hz.
  if (beepsLeft && (int32_t)(millis() - nextBeepAt) >= 0 && !irnode::busy()) {
    M5.Speaker.tone(beepHz, beepMs);
    beepsLeft--;
    nextBeepAt = millis() + 1000;
  }
}

void emitHello(const char* ackId) {
  JsonDocument doc;
  if (ackId) {
    doc["t"] = "ack";
    doc["id"] = ackId;
    doc["ok"] = true;
  } else {
    doc["t"] = "hello";
  }
  doc["proto"] = CE_PROTO;
  doc["fw"] = CE_FW_NAME "@" CE_FW_VERSION;
  doc["board"] = app::S.board;
  doc["chip"] = app::S.chip;
  doc["name"] = app::S.adv ? "Cardputer-Adv" : "Cardputer";
  JsonArray caps = doc["caps"].to<JsonArray>();
  caps.add("ir");
  caps.add("ir-rx");
  caps.add("display");
  caps.add("keys");
  caps.add("speaker");
  doc["rx"] = "G1";
  JsonArray tx = doc["tx"].to<JsonArray>();
  tx.add("G44");
  tx.add("G2");
  doc["txDefault"] = irnode::defaultTx() == irnode::kTxGrove ? "grove" : "led";
  doc["codes"] = store::slotCount();
  doc["uptimeMs"] = millis();
  writeDoc(doc);
}

void emitAck(const char* id, bool ok, const char* err, const char* msg) {
  JsonDocument doc;
  doc["t"] = "ack";
  doc["id"] = id ? id : "";
  doc["ok"] = ok;
  if (!ok) {
    doc["err"] = err ? err : "error";
    if (msg) doc["msg"] = msg;
  }
  doc["ms"] = millis();
  writeDoc(doc);
}

void emitIrAck(const char* id, bool ok, uint32_t ms, uint16_t count, const char* err) {
  JsonDocument doc;
  doc["t"] = "ack";
  doc["id"] = id;
  doc["ok"] = ok;
  doc["ms"] = ms;
  if (ok) {
    doc["entries"] = count;
  } else {
    doc["err"] = err ? err : "tx_failed";
  }
  writeDoc(doc);
}

void emitLog(const char* lvl, const char* msg) {
  JsonDocument doc;
  doc["t"] = "log";
  doc["lvl"] = lvl;
  doc["msg"] = msg;
  writeDoc(doc);
}

void emitKey(const char* key) {
  JsonDocument doc;
  doc["t"] = "key";
  doc["key"] = key;
  writeDoc(doc);
}

void emitPick(const char* item, const char* key, bool fired) {
  JsonDocument doc;
  doc["t"] = "pick";
  doc["item"] = item;
  doc["key"] = key;
  if (fired) doc["fired"] = true;
  writeDoc(doc);
}

void emitLearned(const char* ackId, const char* slot, const char* label, bool stored) {
  // Built by hand: up to 600 timings must fit one 4 KB line.
  const app::Capture& c = app::S.cap;
  const ir::Analysis& a = c.a;
  size_t n = 0;
  auto put = [&](const char* fmt, auto... args) {
    if (n < cfg::kOutMax) n += (size_t)snprintf(out + n, cfg::kOutMax - n, fmt, args...);
  };
  put("{\"t\":\"learned\"");
  if (ackId && ackId[0]) put(",\"id\":\"%s\"", ackId);
  put(",\"khz\":38,\"protocol\":\"%s\",\"proto\":\"%s\"", ir::protoName(a.proto), ir::protoName(a.proto));
  if (a.nbytes && (a.proto == ir::Proto::NEC || a.proto == ir::Proto::AEHA)) {
    char hex[3 * ir::kMaxBytes + 1];
    ir::formatHex(a.bytes, a.nbytes, hex, sizeof(hex));
    put(",\"bytes\":\"%s\",\"bits\":%u,\"unitUs\":%u,\"checkOk\":%s", hex, a.bits, a.unitUs,
        a.checkOk ? "true" : "false");
  }
  put(",\"frames\":%u,\"sameFrames\":%u", a.frames, a.sameFrames);
  if (a.frames > 1) put(",\"frameGapUs\":%lu", (unsigned long)a.gapUs);
  put(",\"marks\":%u,\"durationUs\":%lu", a.marks, (unsigned long)a.durationUs);
  if (c.truncated) put(",\"truncated\":true");
  if (label && label[0]) {
    // Labels are UTF-8 from our own tables or the host; escape quotes and backslashes.
    put(",\"label\":\"");
    for (const char* p = label; *p && n < cfg::kOutMax - 8; p++) {
      if (*p == '"' || *p == '\\') out[n++] = '\\';
      out[n++] = *p;
    }
    put("\"");
  }
  if (slot && slot[0]) put(",\"slot\":\"%s\",\"stored\":%s", slot, stored ? "true" : "false");
  put(",\"us\":[");
  for (uint16_t i = 0; i < c.n; i++) {
    if (n + 8 >= cfg::kOutMax - 4) break;
    put(i ? ",%u" : "%u", c.us[i]);
  }
  put("]}");
  writeLine(n);
}

void emitSpikeCand(const char* candId, const char* part, const char* bytes, const char* fmt, char answer,
                   const char* tx) {
  JsonDocument doc;
  doc["t"] = "spike";
  doc["kind"] = "candidate";
  doc["cand"] = candId;
  doc["part"] = part;
  doc["protocol"] = fmt;
  doc["bytes"] = bytes;
  doc["answer"] = String(answer);
  doc["tx"] = tx;
  doc["ms"] = millis();
  writeDoc(doc);
}

void emitSpikeReplay(const char* slot, const char* label, char answer, const char* tx) {
  JsonDocument doc;
  doc["t"] = "spike";
  doc["kind"] = "replay";
  doc["slot"] = slot;
  doc["label"] = label;
  doc["answer"] = String(answer);
  doc["tx"] = tx;
  doc["ms"] = millis();
  writeDoc(doc);
}

void emitLearnEnd(uint16_t frames, const char* reason) {
  JsonDocument doc;
  doc["t"] = "learnend";
  doc["frames"] = frames;
  doc["reason"] = reason;
  writeDoc(doc);
}

bool restoreMenu() {
  static char buf[4100];
  const size_t n = store::loadMenu(buf, sizeof(buf));
  if (!n) return false;
  JsonDocument doc;
  if (deserializeJson(doc, (const char*)buf, n)) return false;
  app::Menu M;
  if (!parseMenu(doc, M)) return false;
  app::S.menu = M;
  return true;
}

void emitPairRequest() {
  JsonDocument doc;
  doc["t"] = "pairreq";
  doc["chip"] = app::S.chip;
  writeDoc(doc);
}

}  // namespace proto
