#!/bin/bash
# Deploy support-app to the dev droplet (support.whatsfresh.app).
# Run LOCALLY: bash scripts/deploy.sh
#
# Why this exists (task 472): support-app used to be hand-copied to the
# droplet. The 2026-09-28 migration copied an older checkout over code that
# had /deploy-steps and the app_id hydrate default, which silently broke the
# agile grid for a week. Git is the record: this script only deploys what is
# on origin/main, and refuses to paper over drift.
#
# Steps:
#   1. Local gate: clean working tree, HEAD exactly equals origin/main.
#   2. Droplet gate: its checkout must have no local edits (a hot patch there
#      would be silently discarded or fight the pull - fix it in git first).
#   3. git pull --ff-only, npm ci (lockfile-exact), pm2 restart.
#   4. Health check on the app's own port, then the public URL.
#
# support-app is dev-only (not going to prod). Override the host with
# DROPLET_HOST if the dev droplet moves.

set -euo pipefail

DROPLET_HOST="${DROPLET_HOST:-root@142.93.204.168}"
REMOTE_DIR="/home/n8n/support-app"
PM2_NAME="support-app"
PORT=3002
PUBLIC_URL="https://support.whatsfresh.app/agile-board"

cd "$(dirname "$0")/.."

echo "=== support-app deploy (dev) ==="

# 1. Local gate
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "[local] ERROR: uncommitted changes to tracked files - commit them first:" >&2
    git status --short --untracked-files=no >&2
    exit 1
fi
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "[local] ERROR: HEAD ($(git rev-parse --short HEAD)) is not origin/main ($(git rev-parse --short origin/main))." >&2
    echo "        Push (or check out) main first - the droplet deploys origin/main only." >&2
    exit 1
fi
SHA="$(git rev-parse --short HEAD)"
echo "[local] deploying $SHA"

# 2-4. Droplet
ssh -o ConnectTimeout=8 "$DROPLET_HOST" bash -s -- "$REMOTE_DIR" "$PM2_NAME" "$PORT" <<'REMOTE'
set -euo pipefail
DIR="$1"; NAME="$2"; PORT="$3"
cd "$DIR"
G="git -c safe.directory=$DIR"

if [ -n "$($G status --porcelain --untracked-files=no)" ]; then
    echo "[droplet] ERROR: local edits in $DIR - drift from git:" >&2
    $G status --short --untracked-files=no >&2
    exit 1
fi

$G pull -q --ff-only origin main
echo "[droplet] at $($G log --oneline -1)"

npm ci --no-audit --no-fund 2>&1 | grep -E "added|up to date|error" || true

pm2 restart "$NAME" >/dev/null
for i in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:$PORT/agile-board" || true)
    [ "$code" = "200" ] && { echo "[droplet] health check ok (attempt $i)"; exit 0; }
    sleep 2
done
echo "[droplet] ERROR: health check failed (last code: ${code:-none})" >&2
pm2 logs "$NAME" --err --lines 15 --nostream >&2 || true
exit 1
REMOTE

code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "$PUBLIC_URL" || true)
echo "[public] $PUBLIC_URL -> $code"
[ "$code" = "200" ] || { echo "ERROR: public URL not 200" >&2; exit 1; }
echo "=== Done ($SHA) ==="
