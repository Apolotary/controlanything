// Host stand-ins so src/ui.cpp can render into an in-memory 240 x 135 "display".
#pragma once
#include <M5GFX.h>
#include <stdint.h>

uint32_t millis();

struct PreviewSerial {
  explicit operator bool() const { return true; }
};
extern PreviewSerial Serial;

struct PreviewDisplay : public M5Canvas {
  void setBrightness(uint8_t) {}
  void setRotation(uint_fast8_t) {}
};

struct PreviewM5 {
  PreviewDisplay Display;
};
extern PreviewM5 M5;
