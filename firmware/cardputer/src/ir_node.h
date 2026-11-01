// IR transmit (rate limited, one job at a time) and receive (learning) on top of
// IRremoteESP8266. Everything that leaves an IR LED goes through submit().
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace irnode {

enum Tx : uint8_t { kTxLed = 0, kTxGrove = 1 };
enum Phase : uint8_t { kPhaseHack = 0, kPhaseTry = 1, kPhaseReplay = 2, kPhaseLocal = 3 };

struct Meta {
  char id[25] = {0};      // serial command id to ack; empty for local sends
  char label[40] = {0};   // what the screen and the log call it
  int16_t step = -1, of = -1;
  uint8_t phase = kPhaseHack;
  uint8_t tx = kTxLed;
  uint8_t khz = 38;
  uint8_t repeats = 0;    // extra full frames
  uint16_t gapMs = 40;    // space between frames
};

struct Done {
  Meta meta;
  bool ok = false;
  uint32_t startedMs = 0;
  uint32_t sentMs = 0;    // millis() when the last frame left the LED
  uint16_t count = 0;
  const char* err = nullptr;
};

void begin(uint8_t defaultTx);
// nullptr if the job is acceptable, else an error code for the ack ("bad_args").
const char* validate(const uint16_t* us, size_t n, const Meta& m);
bool busy();
// Copies the timings. Returns false (and does nothing) when a job is already pending.
bool submit(const Meta& m, const uint16_t* us, size_t n);
// Runs the pending job once the rate limit allows it. Blocks for the frame time.
void poll();
bool takeDone(Done& out);
// Drops the pending job (panic). A frame already on the air finishes (it is < 0.5 s).
bool cancel(Meta* dropped);
uint32_t lastStartMs();
uint32_t sendCount();
void setPreSendHook(void (*fn)(const Meta&));
void setDefaultTx(uint8_t tx);
uint8_t defaultTx();

// Learning: IRrecv on Grove G1 (M5 IR Unit or any 38 kHz demodulating receiver).
bool rxStart();
void rxStop();
bool rxActive();
// Copies the next capture (microseconds) into `out`; returns the count, 0 if none.
size_t rxPoll(uint16_t* out, size_t cap, bool* truncated);
uint32_t rxCaptures();

}  // namespace irnode
