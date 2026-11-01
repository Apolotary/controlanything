#!/usr/bin/env bash
# Morning spike helper for the Quest 3 (G1b): let Quest Browser use the passthrough camera, tunnel the server,
# restart the browser and open the camera spike page.
#
#   scripts/quest-grant-camera.sh            grant + adb reverse + restart Quest Browser + open ?spike=camera
#   scripts/quest-grant-camera.sh --no-open  same, without opening the page
#   ANDROID_SERIAL=<serial> scripts/...      pick a device when several are attached
#
# Why: Quest Browser 150 may never show the HEADSET_CAMERA permission prompt; then only the avatar camera is listed and
# getUserMedia({video:{facingMode:{exact:'environment'}}}) fails with OverconstrainedError. Granting the permission
# over adb fixes it (Meta developer investigation, see research/04-quest-stack.md §2).
set -u

PKG="${QUEST_BROWSER_PKG:-com.oculus.browser}"
PORT="${HTTP_PORT:-8787}"
URL="http://localhost:${PORT}/quest/?spike=camera"
OPEN=1
[ "${1:-}" = "--no-open" ] && OPEN=0

pass=0
fail=0
ok() { printf '  \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail + 1)); }
note() { printf '  .... %s\n' "$*"; }

echo "Quest camera grant ($(date '+%H:%M:%S'))"

if ! command -v adb >/dev/null 2>&1; then
  bad "adb not found (brew install android-platform-tools)"
  exit 1
fi

# 1. exactly one authorised device
states=$(adb devices | awk 'NR>1 && NF>=2 {print $2}')
if [ -z "${ANDROID_SERIAL:-}" ]; then
  n=$(printf '%s\n' "$states" | grep -c '^device$' || true)
  if printf '%s\n' "$states" | grep -q '^unauthorized$'; then
    bad "headset is 'unauthorized': put it on and accept 'Allow USB debugging' (tick 'always allow'), then rerun"
    exit 1
  fi
  if [ "$n" -eq 0 ]; then
    bad "no device: plug the Quest into the Mac with USB-C, developer mode on"
    exit 1
  fi
  if [ "$n" -gt 1 ]; then
    bad "several devices attached: set ANDROID_SERIAL=<serial> (see adb devices)"
    exit 1
  fi
fi
model=$(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r')
os=$(adb shell getprop ro.build.version.incremental 2>/dev/null | tr -d '\r')
ok "device: ${model:-unknown} (build ${os:-?})"

# 2. the browser package
if ! adb shell pm list packages 2>/dev/null | tr -d '\r' | grep -qx "package:${PKG}"; then
  bad "package ${PKG} not found; browser-like packages:"
  adb shell pm list packages 2>/dev/null | tr -d '\r' | grep -i browser | sed 's/^/        /'
  exit 1
fi
ver=$(adb shell dumpsys package "$PKG" 2>/dev/null | tr -d '\r' | grep -m1 versionName | sed 's/.*versionName=//')
ok "Quest Browser ${ver:-?} (${PKG})"

# 3. grants: the headset camera is the one that matters; CAMERA/RECORD_AUDIO are belt and braces
for perm in horizonos.permission.HEADSET_CAMERA android.permission.CAMERA android.permission.RECORD_AUDIO; do
  out=$(adb shell pm grant "$PKG" "$perm" 2>&1 | tr -d '\r')
  if [ -z "$out" ]; then
    ok "granted ${perm}"
  elif printf '%s' "$out" | grep -qi 'not a changeable permission\|has not requested\|Unknown permission'; then
    if [ "$perm" = "horizonos.permission.HEADSET_CAMERA" ]; then
      bad "${perm}: ${out}"
    else
      note "${perm}: ${out} (not needed on this build)"
    fi
  else
    bad "${perm}: ${out}"
  fi
done
granted=$(adb shell dumpsys package "$PKG" 2>/dev/null | tr -d '\r' | grep -E 'HEADSET_CAMERA|android.permission.CAMERA|RECORD_AUDIO' | grep -c 'granted=true' || true)
note "dumpsys lists ${granted} of those permission(s) as granted=true"

# 4. tunnel the Mac server: http://localhost on the headset is a secure context (WebXR, camera, mic, no certs)
if adb reverse "tcp:${PORT}" "tcp:${PORT}" >/dev/null 2>&1 && adb reverse --list | grep -q "tcp:${PORT}"; then
  ok "adb reverse tcp:${PORT} → Mac :${PORT}"
else
  bad "adb reverse tcp:${PORT} failed"
fi
adb reverse tcp:5174 tcp:5174 >/dev/null 2>&1 && note "also reversed :5174 (vite dev:hmr)"

# 5. the server on the Mac
if health=$(curl -s -m 3 "http://127.0.0.1:${PORT}/api/health"); then
  mode=$(printf '%s' "$health" | sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p')
  ok "server up on :${PORT} (${mode:-?} mode)"
else
  bad "no server on :${PORT}: run 'npm run dev' in the repo first"
fi

# 6. restart the browser so it picks up the grant, then open the spike
adb shell am force-stop "$PKG" >/dev/null 2>&1 && ok "restarted Quest Browser (force-stop)"
if [ "$OPEN" -eq 1 ]; then
  if adb shell am start -a android.intent.action.VIEW -d "$URL" "$PKG" >/dev/null 2>&1; then
    ok "opened ${URL} in the headset"
  else
    bad "could not open ${URL}; type it in Quest Browser"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mREADY\033[0m (%d checks). In the headset: tap "1 · Camera" (pick Allow if asked), then "2 · Enter AR".\n' "$pass"
  echo "Expect the live camera on a plane, '≥ 10 fps in session', 'posted scan.frame', then VERDICT PASS."
  echo "Debug from the Mac: chrome://inspect/#devices → Quest Browser tab → inspect (console logs start with [spike])."
else
  printf '\033[31mNOT READY\033[0m: %d failed check(s) above.\n' "$fail"
  exit 1
fi
