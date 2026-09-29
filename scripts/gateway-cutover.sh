#!/bin/sh
set -eu

GATEWAY_ROOT=${GATEWAY_ROOT:-/home/pi/gateway}
SERVICE_NAME=${SERVICE_NAME:-gateway.service}
RELEASE_REF=${RELEASE_REF:-}
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
  esac
done

[ -n "$RELEASE_REF" ] || { echo "set RELEASE_REF=<commit-or-ref>" >&2; exit 2; }
[ -d "$GATEWAY_ROOT/.git" ] || { echo "missing Git checkout: $GATEWAY_ROOT" >&2; exit 1; }

CURRENT=$(git -C "$GATEWAY_ROOT" rev-parse HEAD)
TARGET=$(git -C "$GATEWAY_ROOT" rev-parse "$RELEASE_REF")

echo "current_commit=$CURRENT"
echo "target_commit=$TARGET"
echo "service=$SERVICE_NAME"
echo "action=backup, install dependencies, switch checkout, restart service, verify"

[ "$APPLY" -eq 1 ] || { echo "dry_run=true (pass --apply to execute)"; exit 0; }

"$(dirname -- "$0")/gateway-backup.sh"
git -C "$GATEWAY_ROOT" diff --quiet && git -C "$GATEWAY_ROOT" diff --cached --quiet || {
  echo "cutover: refusing to overwrite a dirty worktree" >&2; exit 1;
}

git -C "$GATEWAY_ROOT" switch --detach "$TARGET"
npm --prefix "$GATEWAY_ROOT" ci --no-audit --no-fund
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl is-active --quiet "$SERVICE_NAME"
echo "cutover=completed; verify health, UI, Socket.IO, and live telemetry"
