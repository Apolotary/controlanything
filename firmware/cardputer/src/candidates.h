// Candidate library for the G1 ceiling-light spike.
//
// No IR codes have ever been published for Koizumi lighting remotes (KRH-TG-9A
// included), so this list is a long shot: other Japanese makers' discrete OFF codes,
// each with a matching ON code to confirm a hit. Learning the real remote with an IR
// receiver on Grove is the reliable path. Order and bytes follow the research file
// research/devices/jp-ceiling-light-ir.json (searchCandidates; bytes in send order,
// LSB-first per byte). Never sweep unknown command bytes: some makers use them for
// channel programming, which can leave a lamp deaf to its own remote.
#pragma once
#include <stdint.h>

namespace cand {

enum class Fmt : uint8_t { NEC, AEHA, IRIS };

struct Candidate {
  const char* id;          // <= 12 chars, also the NVS key stem
  const char* brand;
  uint8_t ch;              // remote channel, 0 = n/a
  const char* what;        // what the main code should do
  Fmt fmt;
  uint16_t unitUs;         // AEHA T
  const char* bytes;
  uint8_t repeats;         // extra full frames the real remote sends
  uint16_t gapMs;          // space between those frames
  const char* confirmWhat; // the code that confirms a hit
  const char* confirmBytes;
  const char* confidence;
};

constexpr Candidate kList[] = {
    {"pana1-off", "Panasonic", 1, "OFF", Fmt::AEHA, 432, "2C 52 09 2F 26", 1, 75, "FULL ON", "2C 52 09 2C 25", "high"},
    {"nec1-off", "NEC/HotaluX", 1, "OFF", Fmt::NEC, 0, "82 6D BE 41", 0, 40, "FULL ON", "82 6D A6 59", "high"},
    {"tosh1-off", "Toshiba/NVC", 1, "OFF", Fmt::NEC, 0, "E7 0C 8B 74", 0, 40, "ON", "E7 0C A2 5D", "medium"},
    {"hit-off", "Hitachi T425", 1, "OFF", Fmt::AEHA, 425, "01 10 30 50 AF 00 FF 03 FC C2 3D", 0, 100, "NIGHT",
     "01 10 30 50 AF 00 FF 09 F6 C2 3D", "low"},
    {"hit-off390", "Hitachi/Sharp T390", 1, "OFF", Fmt::AEHA, 390, "01 10 30 50 AF 00 FF 03 FC C2 3D", 0, 100,
     "NIGHT", "01 10 30 50 AF 00 FF 09 F6 C2 3D", "low"},
    {"iris-cycle", "Iris Ohyama", 1, "CYCLE", Fmt::IRIS, 500, "C0 81 40 00 5B", 0, 100, "CYCLE again",
     "C0 81 40 00 5B", "low"},
    {"taki-tgl", "Takizumi", 1, "TOGGLE", Fmt::NEC, 0, "84 52 32 CD", 1, 47, "TOGGLE back", "84 52 32 CD", "medium"},
    {"odelic-off", "Odelic?", 1, "OFF", Fmt::NEC, 0, "84 51 2A D5", 0, 40, "ON", "84 51 9A 65", "low"},
    {"pana2-off", "Panasonic", 2, "OFF", Fmt::AEHA, 432, "2C 52 09 37 3E", 1, 75, "FULL ON", "2C 52 09 34 3D", "high"},
    {"pana3-off", "Panasonic", 3, "OFF", Fmt::AEHA, 432, "2C 52 09 3F 36", 1, 75, "FULL ON", "2C 52 09 3C 35", "high"},
    {"nec2-off", "NEC/HotaluX", 2, "OFF", Fmt::NEC, 0, "82 6D 3E C1", 0, 40, "ON", "82 6D 3D C2", "high"},
};

constexpr int kCount = (int)(sizeof(kList) / sizeof(kList[0]));

inline const char* fmtName(Fmt f) {
  switch (f) {
    case Fmt::NEC: return "NEC";
    case Fmt::AEHA: return "AEHA";
    default: return "IRIS";
  }
}

inline int find(const char* id) {
  for (int i = 0; i < kCount; i++) {
    const char* a = kList[i].id;
    const char* b = id;
    while (*a && *a == *b) {
      a++;
      b++;
    }
    if (*a == 0 && *b == 0) return i;
  }
  return -1;
}

// The buttons the standalone learn flow asks for, discrete keys first (research §learnProcedure).
struct LearnButton {
  const char* slot;   // NVS slot name, also the label the host sees
  const char* ja;     // the remote's printed label (inferred for the KRH-TG-9A)
  const char* en;
};

constexpr LearnButton kLearnButtons[] = {
    {"full", "全灯", "FULL"},      {"off", "消灯", "OFF"},        {"night", "常夜灯", "NIGHT"},
    {"brighter", "明るく", "BRIGHTER"}, {"darker", "暗く", "DARKER"}, {"warmer", "暖かい光", "WARMER"},
    {"cooler", "白い光", "COOLER"},
};
constexpr int kLearnCount = (int)(sizeof(kLearnButtons) / sizeof(kLearnButtons[0]));

}  // namespace cand
