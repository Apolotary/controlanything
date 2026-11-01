// Screens for the 240 x 135 display, drawn into one off-screen canvas.
//
// Visual language (research/15-cyberdeck-design.md §12): background #0A0E12, text
// #F3F7FA, accents cyan #38F0FF and volt #EEFF41 only, ok #5CFFA3 / fail #FF5A3C only
// for verdicts the host relays. No strokes under 2 px. Nothing flashes faster than 1 Hz:
// the send flash re-triggers at most once a second and otherwise stays lit.
#pragma once
#include <stdint.h>

namespace ui {

void begin();
void dirty();          // something changed: redraw on the next frame
void frame();          // redraw if dirty or animating (<= 30 fps)
void renderNow();      // redraw and push immediately (before a blocking IR send)

}  // namespace ui
