#!/bin/sh
set -eu

GATEWAY_ROOT=${GATEWAY_ROOT:-/home/pi/gateway}
BACKUP_ROOT=${BACKUP_ROOT:-/home/pi/backups}
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_ROOT/gateway-$STAMP"

[ -d "$GATEWAY_ROOT" ] || { echo "backup: missing $GATEWAY_ROOT" >&2; exit 1; }
mkdir -p "$DEST"

if [ -d "$GATEWAY_ROOT/data" ]; then cp -a "$GATEWAY_ROOT/data" "$DEST/data"; fi
if [ -f "$GATEWAY_ROOT/settings.json5" ]; then cp -a "$GATEWAY_ROOT/settings.json5" "$DEST/settings.json5"; fi

if command -v sudo >/dev/null 2>&1; then
  sudo cp -a /etc/nginx/sites-available/gateway "$DEST/nginx-gateway" 2>/dev/null || true
  sudo cp -a /etc/systemd/system/gateway.service "$DEST/gateway.service" 2>/dev/null || true
else
  cp -a /etc/nginx/sites-available/gateway "$DEST/nginx-gateway" 2>/dev/null || true
  cp -a /etc/systemd/system/gateway.service "$DEST/gateway.service" 2>/dev/null || true
fi

git -C "$GATEWAY_ROOT" rev-parse HEAD > "$DEST/source-commit"
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/created-at"
echo "backup=$DEST"
