// Build-wide constants for the ControlAnything IR node.
#pragma once
#include <stdint.h>

#define CE_FW_NAME "ce-cardputer"
#define CE_FW_VERSION "0.1.0"
#define CE_PROTO 1

#ifndef CE_TARGET_ADV
#define CE_TARGET_ADV 0
#endif

namespace cfg {

// Pins. The IR LED is G44 on both the Cardputer and the Cardputer-Adv (M5Stack docs).
// The M5 IR Unit (U002) on the Grove port: yellow = its LED (TX) on G2, white = its
// 38 kHz receiver (RX) on G1.
constexpr uint8_t kPinIrLed = 44;
constexpr uint8_t kPinGroveTx = 2;
constexpr uint8_t kPinGroveRx = 1;

// IR limits (SPEC §3.2: IR <= 4 Hz). The firmware is the last line of defence.
constexpr uint32_t kIrMinStartGapMs = 250;   // send starts at least 250 ms apart
constexpr uint16_t kIrMaxEntries = 1024;     // timings per frame
constexpr uint32_t kIrMaxFrameUs = 500000;   // one frame may last at most 0.5 s
constexpr uint8_t kIrMaxRepeats = 5;         // extra full frames
constexpr uint16_t kIrMaxGapMs = 500;
constexpr uint8_t kIrDefaultKhz = 38;

// Learning (IRremoteESP8266 IRrecv on G1).
constexpr uint16_t kRxBufferEntries = 1024;
constexpr uint8_t kRxTimeoutMs = 100;        // one capture spans a remote's 2-frame press (~75 ms gap)
constexpr uint16_t kLearnMaxEntries = 600;   // longest capture kept or reported (fits a 4 KB line)
constexpr uint32_t kLearnDefaultTimeoutMs = 30000;

// Serial JSON lines.
constexpr uint32_t kSerialBaud = 115200;     // ignored by the USB-Serial/JTAG port
constexpr uint16_t kLineMax = 8192;          // longest accepted line
constexpr uint16_t kOutMax = 4096;           // longest emitted line

// Storage.
constexpr uint8_t kMaxSlots = 12;            // learned codes kept in NVS

// UI. Photosensitivity: nothing on screen flashes faster than 1 Hz.
constexpr uint32_t kFlashMinIntervalMs = 1000;
constexpr uint32_t kFlashOnMs = 120;
constexpr uint32_t kBootWindowMs = 1800;     // press S (spike) or L (learn) while the splash shows

}  // namespace cfg
