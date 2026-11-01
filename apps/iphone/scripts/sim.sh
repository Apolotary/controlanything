#!/bin/zsh
# iPhone app in the iOS Simulator, headless (no Simulator UI automation needed).
#   apps/iphone/scripts/sim.sh build                 xcodebuild for the simulator
#   apps/iphone/scripts/sim.sh run [-CEServer url]    install + (re)launch, extra launch args passed through
#   apps/iphone/scripts/sim.sh shot <name>           screenshot -> apps/iphone/screenshots/<name>.png
#   apps/iphone/scripts/sim.sh mock <args...>        scripts/mock-brain.ts (scenarios, debug k=v, --listen)
# UDID defaults to the booted simulator; set UDID=<id> to pick one.
set -e
ROOT=${0:A:h:h:h:h}
IPHONE=$ROOT/apps/iphone
UDID=${UDID:-booted}
APP=$IPHONE/build/DerivedData/Build/Products/Debug-iphonesimulator/ControlEverything.app
BUNDLE=dev.controleverything.ios
cmd=$1; shift || true
case $cmd in
  build)
    xcodebuild -project $IPHONE/ControlEverything.xcodeproj -scheme ControlEverything \
      -destination "platform=iOS Simulator,${DEST:-name=iPhone 18 Pro}" -derivedDataPath $IPHONE/build/DerivedData build \
      | grep -E "error:|warning:|BUILD (SUCCEEDED|FAILED)" | grep -v "^ " | sort -u ;;
  run)
    xcrun simctl terminate $UDID $BUNDLE 2>/dev/null || true
    xcrun simctl install $UDID $APP
    xcrun simctl launch $UDID $BUNDLE "$@" ;;
  shot)
    mkdir -p $IPHONE/screenshots
    xcrun simctl io $UDID screenshot $IPHONE/screenshots/${1:-shot}.png 2>&1 | tail -1 ;;
  mock)
    (cd $ROOT && npx tsx apps/iphone/scripts/mock-brain.ts "$@") ;;
  *)
    echo "usage: sim.sh build | run [launch args] | shot <name> | mock <args>"; exit 2 ;;
esac
