#include "ir_node.h"

#include <Arduino.h>
#include <IRrecv.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <M5Unified.h>
#include <string.h>

#include "config.h"

namespace irnode {
namespace {

IRsend ledTx(cfg::kPinIrLed);
IRsend groveTx(cfg::kPinGroveTx);
bool groveReady = false;
uint8_t defaultTx_ = kTxLed;

uint16_t jobBuf[cfg::kIrMaxEntries];
uint16_t jobLen = 0;
Meta jobMeta;
bool pending = false;
uint32_t queuedAt = 0;

Done done_;
bool doneReady = false;

uint32_t lastStart = 0;
bool everSent = false;
uint32_t sends = 0;
void (*preSend)(const Meta&) = nullptr;

IRrecv* rx = nullptr;
decode_results results;
bool rxOn = false;
uint32_t captures = 0;

IRsend& txFor(uint8_t tx) {
  if (tx == kTxGrove) {
    if (!groveReady) {
      groveTx.begin();
      groveTx.calibrate();
      groveReady = true;
    }
    return groveTx;
  }
  return ledTx;
}

}  // namespace

void begin(uint8_t defTx) {
  ledTx.begin();
  ledTx.calibrate();
  defaultTx_ = defTx ? kTxGrove : kTxLed;
}

void setDefaultTx(uint8_t tx) { defaultTx_ = tx ? kTxGrove : kTxLed; }
uint8_t defaultTx() { return defaultTx_; }

const char* validate(const uint16_t* us, size_t n, const Meta& m) {
  if (n < 2 || n > cfg::kIrMaxEntries) return "bad_args";
  if (m.khz < 30 || m.khz > 60) return "bad_args";
  if (m.repeats > cfg::kIrMaxRepeats || m.gapMs > cfg::kIrMaxGapMs) return "bad_args";
  uint32_t total = 0;
  for (size_t i = 0; i < n; i++) {
    if (us[i] == 0 || us[i] > 65000) return "bad_args";
    total += us[i];
  }
  if (total > cfg::kIrMaxFrameUs) return "bad_args";
  return nullptr;
}

bool busy() { return pending; }

bool submit(const Meta& m, const uint16_t* us, size_t n) {
  if (pending || n > cfg::kIrMaxEntries) return false;
  memcpy(jobBuf, us, n * sizeof(uint16_t));
  jobLen = (uint16_t)n;
  jobMeta = m;
  pending = true;
  queuedAt = millis();
  return true;
}

void poll() {
  if (!pending) return;
  const uint32_t now = millis();
  if (everSent && now - lastStart < cfg::kIrMinStartGapMs) return;  // <= 4 Hz

  if (preSend) preSend(jobMeta);
  M5.Display.waitDMA();
  const bool wasRx = rxOn;
  if (wasRx) rx->disableIRIn();  // don't learn our own blast

  lastStart = millis();
  everSent = true;
  IRsend& tx = txFor(jobMeta.tx);
  for (uint8_t r = 0; r <= jobMeta.repeats; r++) {
    tx.sendRaw(jobBuf, jobLen, (uint16_t)(jobMeta.khz * 1000u));
    if (r < jobMeta.repeats) delay(jobMeta.gapMs);
  }
  const uint32_t end = millis();
  sends++;

  if (wasRx) {
    rx->enableIRIn();
    rx->resume();
  }

  done_.meta = jobMeta;
  done_.ok = true;
  done_.startedMs = lastStart;
  done_.sentMs = end;
  done_.count = jobLen;
  done_.err = nullptr;
  doneReady = true;
  pending = false;
}

bool takeDone(Done& out) {
  if (!doneReady) return false;
  out = done_;
  doneReady = false;
  return true;
}

bool cancel(Meta* dropped) {
  if (!pending) return false;
  if (dropped) *dropped = jobMeta;
  pending = false;
  return true;
}

uint32_t lastStartMs() { return lastStart; }
uint32_t sendCount() { return sends; }
void setPreSendHook(void (*fn)(const Meta&)) { preSend = fn; }

bool rxStart() {
  if (!rx) {
    rx = new IRrecv(cfg::kPinGroveRx, cfg::kRxBufferEntries, cfg::kRxTimeoutMs, true);
    rx->setUnknownThreshold(12);
    rx->setTolerance(25);
  }
  if (!rxOn) {
    rx->enableIRIn();
    rxOn = true;
  }
  return true;
}

void rxStop() {
  if (rx && rxOn) rx->disableIRIn();
  rxOn = false;
}

bool rxActive() { return rxOn; }

size_t rxPoll(uint16_t* out, size_t cap, bool* truncated) {
  if (!rxOn || !rx) return 0;
  if (!rx->decode(&results)) return 0;  // save buffer: decode() re-arms the receiver itself
  size_t n = 0;
  bool cut = results.overflow;
  // rawbuf[0] is the silence before the first mark; the rest alternate mark/space in 2 us ticks.
  for (uint16_t i = 1; i < results.rawlen; i++) {
    if (n >= cap) {
      cut = true;
      break;
    }
    uint32_t v = (uint32_t)results.rawbuf[i] * kRawTick;
    out[n++] = (uint16_t)(v > 65000 ? 65000 : v);
  }
  if (n % 2 == 0 && n > 0) n--;  // keep it ending with a mark
  if (truncated) *truncated = cut;
  if (n < 4) return 0;  // noise
  captures++;
  return n;
}

uint32_t rxCaptures() { return captures; }

}  // namespace irnode
