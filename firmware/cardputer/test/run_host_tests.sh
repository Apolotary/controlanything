#!/bin/sh
# Host-side unit tests for the pure IR codec (no board needed): sh test/run_host_tests.sh
set -e
cd "$(dirname "$0")/.."
out="${TMPDIR:-/tmp}/ce-codec-test"
c++ -std=c++17 -Wall -Wextra -O1 -o "$out" test/codec_test.cpp src/ir_codec.cpp
"$out"
