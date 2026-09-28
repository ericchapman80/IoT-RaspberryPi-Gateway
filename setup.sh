#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

MODE="${1:-test}"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is required (see .nvmrc)" >&2
  exit 1
fi

echo "Using Node $(node --version) and npm $(npm --version)"

case "$MODE" in
  test)
    # Tests and the preview do not need serialport's native postinstall build.
    npm ci --ignore-scripts --no-audit --no-fund
    npm test
    ;;
  preview)
    npm ci --ignore-scripts --no-audit --no-fund
    exec node dev/preview-server.js
    ;;
  gateway)
    # The real gateway owns the radio and therefore needs native dependencies.
    npm ci --no-audit --no-fund
    exec node gateway.js
    ;;
  *)
    echo "usage: $0 {test|preview|gateway}" >&2
    exit 2
    ;;
esac
