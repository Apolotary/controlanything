#!/usr/bin/env bash
# Pull the Quest's own recordings (Meta button → Camera → Record video) to the Mac and check each one.
# Usage: scripts/quest-pull-videos.sh [dest]   (default: research/video/footage/quest)
# Prints, per clip: resolution, length, and whether it has an audio track. Already-pulled clips are skipped.
set -euo pipefail
DEST="${1:-research/video/footage/quest}"
mkdir -p "$DEST"

state="$(adb get-state 2>&1 || true)"
if [[ "$state" != "device" ]]; then
  echo "Quest not ready (adb says: $state)."
  echo "Put the headset on, accept 'Allow USB debugging' (tick 'Always allow from this computer'), then run this again."
  exit 1
fi

found=0
for dir in /sdcard/Oculus/VideoShots /sdcard/Movies; do
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    found=1
    name="$(basename "$f")"
    if [[ ! -f "$DEST/$name" ]]; then adb pull "$f" "$DEST/$name" >/dev/null; fi
    size="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$DEST/$name" 2>/dev/null || echo '?')"
    secs="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$DEST/$name" 2>/dev/null | cut -d. -f1)"
    audio="$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$DEST/$name" 2>/dev/null | head -1)"
    echo "$name  ${size}  ${secs:-?}s  audio: ${audio:-NONE}"
  done < <(adb shell "ls -1 $dir/*.mp4 2>/dev/null" | tr -d '\r')
done
[[ $found -eq 0 ]] && echo "No recordings found on the Quest yet (looked in /sdcard/Oculus/VideoShots and /sdcard/Movies)."
echo "Saved in $DEST"
