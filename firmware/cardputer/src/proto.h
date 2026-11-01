// USB-serial JSON lines shared with the Mac companion (apps/companion, Web Serial).
// One JSON object per line; every host command carries "t" and "id" and gets exactly
// one {"t":"ack","id":...} back. Lines that do not start with '{' are ignored by the
// host (ROM boot noise). See firmware/cardputer/README.md for the full protocol.
#pragma once
#include <stdint.h>

namespace proto {

void begin();
void poll();   // read and dispatch complete lines

void emitHello(const char* ackId);   // nullptr: unsolicited {"t":"hello",...}
void emitAck(const char* id, bool ok, const char* err = nullptr, const char* msg = nullptr);
void emitIrAck(const char* id, bool ok, uint32_t ms, uint16_t count, const char* err);
void emitLog(const char* lvl, const char* msg);
void emitKey(const char* key);
void emitPick(const char* item, const char* key, bool fired);
// The capture in app::S.cap. `slot` is set when it was stored; `final` false = a first press.
void emitLearned(const char* ackId, const char* slot, const char* label, bool stored);
void emitSpikeCand(const char* cand, const char* part, const char* bytes, const char* fmt, char answer,
                   const char* tx);
void emitSpikeReplay(const char* slot, const char* label, char answer, const char* tx);
void emitPairRequest();
void emitLearnEnd(uint16_t frames, const char* reason);
// Re-load the last hack menu sent with "persist":true (standalone remote after a reboot).
bool restoreMenu();

}  // namespace proto
