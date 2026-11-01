#include "../src/ir_codec.h"
#include <cstdio>
#include <cstring>
#include <cassert>
#include <vector>
using namespace ir;
static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
int main() {
  uint8_t b[36]; uint16_t us[1024]; char s[200];
  // parseHex
  CHECK(parseHex("82 6D BE 41", b, 36) == 4 && b[0]==0x82 && b[3]==0x41);
  CHECK(parseHex("2C52092F26", b, 36) == 5 && b[4]==0x26);
  CHECK(parseHex("0x2C,0x52", b, 36) == 2 && b[1]==0x52);
  CHECK(parseHex("zz", b, 36) == -1);
  formatHex(b, 2, s, sizeof s); CHECK(strcmp(s, "2C 52") == 0);
  // NEC encode -> analyze
  parseHex("82 6D BE 41", b, 36);
  size_t n = encode(necFormat(), b, 4, us, 1024);
  CHECK(n == 67);
  CHECK(us[0]==9000 && us[1]==4500);
  // 0x82 LSB-first = 0,1,0,0,0,0,0,1 -> spaces 562,1688,...
  CHECK(us[3]==562 && us[5]==1688);
  Analysis a = analyze(us, n);
  CHECK(a.proto == Proto::NEC && a.bits == 32 && a.checkOk && memcmp(a.bytes, b, 4)==0);
  describe(a, s, sizeof s); printf("%s\n", s);
  // AEHA Panasonic, two frames 75 ms apart
  parseHex("2C 52 09 2F 26", b, 36);
  n = encode(aehaFormat(432), b, 5, us, 1024);
  CHECK(n == 83);
  std::vector<uint16_t> two(us, us+n); two.push_back(65000 > 75000 ? 0 : 65000); two.insert(two.end(), us, us+n);
  a = analyze(two.data(), two.size());
  CHECK(a.proto == Proto::AEHA && a.bits == 40 && a.checkOk && a.unitUs == 432 && a.frames == 2 && a.sameFrames == 1);
  describe(a, s, sizeof s); printf("%s\n", s);
  // stretched receiver timings: marks +120, spaces -120
  std::vector<uint16_t> st(us, us+n);
  for (size_t i = 0; i < st.size(); i++) st[i] = (i & 1) ? st[i] - 120 : st[i] + 120;
  a = analyze(st.data(), st.size());
  CHECK(a.proto == Proto::AEHA && a.bits == 40 && a.checkOk);
  CHECK(sameCode(us, n, st.data(), st.size()));
  // Hitachi 88-bit
  CHECK(parseHex("01 10 30 50 AF 00 FF 03 FC C2 3D", b, 36) == 11);
  n = encode(aehaFormat(425), b, 11, us, 1024);
  CHECK(n == 179);
  a = analyze(us, n); CHECK(a.proto == Proto::AEHA && a.bits == 88 && a.checkOk);
  // NEC with hold repeats
  parseHex("E7 0C 8B 74", b, 36);
  n = encode(necFormat(), b, 4, us, 1024);
  std::vector<uint16_t> h(us, us+n); h.push_back(40000); h.push_back(9000); h.push_back(2250); h.push_back(562); h.push_back(30000); h.push_back(9000); h.push_back(2250); h.push_back(562);
  a = analyze(h.data(), h.size());
  CHECK(a.proto == Proto::NEC && a.necRepeats == 2 && a.frames == 3 && a.gapUs == 40000);
  // Iris pulse width MSB-first
  parseHex("C0 81 40 00 5B", b, 36);
  n = encode(irisFormat(), b, 5, us, 1024);
  CHECK(n == 4 + 80 + 1 && us[4] == 1500 /* C0 msb=1 */ && us[8] == 500);
  a = analyze(us, n); CHECK(a.proto == Proto::Unknown);
  describe(a, s, sizeof s); printf("%s\n", s);
  // different codes differ
  parseHex("82 6D BE 41", b, 36); size_t n1 = encode(necFormat(), b, 4, us, 1024);
  uint16_t us2[1024]; parseHex("82 6D A6 59", b, 36); size_t n2 = encode(necFormat(), b, 4, us2, 1024);
  CHECK(!sameCode(us, n1, us2, n2));
  printf(fails ? "FAILED %d\n" : "ALL OK\n", fails);
  return fails != 0;
}
