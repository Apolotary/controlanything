#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_BIN="$TASK_ROOT/apps/server/.data/muse-code/bin"
TASK_EXPECTED="$TASK_BIN/muse-bin-1.4.14-R7309.1"
if [[ -x "$TASK_EXPECTED" ]]; then
  "$TASK_EXPECTED" --version
  exit 0
fi
TASK_INSTALLER="$(mktemp "${TMPDIR:-/tmp}/ce-muse-installer.XXXXXX")"
trap 'rm -f "$TASK_INSTALLER"' EXIT
curl --proto '=https' -fsSL https://dev.meta.ai/install.sh -o "$TASK_INSTALLER"
MUSE_INSTALL_DIR="$TASK_BIN" MUSE_NO_MODIFY_PATH=1 MUSE_LOGIN=0 bash "$TASK_INSTALLER"
if [[ ! -x "$TASK_EXPECTED" ]]; then
  printf '%s\n' 'The released Muse Code version differs from the verified 1.4.14-R7309.1. Review its flags before changing the pinned host.' >&2
  exit 1
fi
"$TASK_EXPECTED" --version
