#!/bin/sh
# Host preview of the Cardputer screens: builds M5GFX natively (needs SDL2 headers, e.g.
# `brew install sdl2`) and writes preview/out/*.png. Run `pio run -e cardputer` once first
# so .pio/libdeps holds M5GFX.
set -e
cd "$(dirname "$0")/.."
GFX=.pio/libdeps/cardputer/M5GFX/src
OBJ=preview/out/obj
mkdir -p "$OBJ"
CFLAGS="$(sdl2-config --cflags) -I$GFX -Ipreview -DCE_PREVIEW -O1 -w"
if [ ! -f "$OBJ/.gfx-built" ]; then
  for f in $(find "$GFX" -name '*.c'); do cc $CFLAGS -c "$f" -o "$OBJ/o$(echo "$f" | tr '/.' '__').o"; done
  for f in $(find "$GFX" -name '*.cpp'); do c++ -std=c++17 $CFLAGS -c "$f" -o "$OBJ/o$(echo "$f" | tr '/.' '__').o"; done
  touch "$OBJ/.gfx-built"
fi
c++ -std=c++17 $CFLAGS -Wall preview/main.cpp preview/stubs.cpp src/ui.cpp src/ir_codec.cpp "$OBJ"/*.o \
  $(sdl2-config --libs) -o preview/out/preview
./preview/out/preview
