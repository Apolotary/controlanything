#!/bin/zsh
# Rebuild one app for the LIVE server without breaking pages that are already open.
# Builds to a temp dir, then copies over apps/<app>/dist WITHOUT deleting old hashed chunks
# (a loaded Quest page may still lazy-load them). The running server serves dist/ directly; no restart needed
# for quest/companion/sim (restart the server only for apps/server or packages/protocol changes).
# Usage: scripts/deploy-live.sh quest|companion|sim
set -e
app=${1:?usage: scripts/deploy-live.sh quest|companion|sim}
root=${0:A:h:h}
out=$(mktemp -d)/build-$app
cd $root/apps/$app
npx tsc -p tsconfig.json
npx vite build --outDir $out --emptyOutDir 2>&1 | grep -E "built in|error" || true
rsync -a $out/ $root/apps/$app/dist/
echo "deployed $app"
