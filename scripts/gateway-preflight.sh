#!/bin/sh
set -eu

GATEWAY_ROOT=${GATEWAY_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}

fail() { echo "preflight: $*" >&2; exit 1; }

[ -f "$GATEWAY_ROOT/gateway.js" ] || fail "gateway.js not found at $GATEWAY_ROOT"
[ -f "$GATEWAY_ROOT/package-lock.json" ] || fail "package-lock.json is required"
command -v node >/dev/null 2>&1 || fail "node is not installed"
command -v npm >/dev/null 2>&1 || fail "npm is not installed"

echo "node=$(node --version)"
echo "npm=$(npm --version)"
echo "gateway_root=$GATEWAY_ROOT"

if [ -e /dev/ttyUSB0 ]; then
  echo "serial_device=/dev/ttyUSB0 present (production owner must remain singular)"
else
  echo "serial_device=/dev/ttyUSB0 not present"
fi

if git -C "$GATEWAY_ROOT" diff --quiet && git -C "$GATEWAY_ROOT" diff --cached --quiet; then
  echo "git_worktree=clean"
else
  echo "git_worktree=dirty (review local changes before cutover)"
fi

echo "preflight=passed"
