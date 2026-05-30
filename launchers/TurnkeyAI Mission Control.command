#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHECKOUT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -f "$CHECKOUT_DIR/package.json" ] && [ -f "$CHECKOUT_DIR/packages/cli/src/cli.ts" ]; then
  exec npm --prefix "$CHECKOUT_DIR" run app -- "$@"
fi

if command -v turnkeyai >/dev/null 2>&1; then
  exec turnkeyai app "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx @turnkeyai/cli app "$@"
fi

echo "TurnkeyAI Mission Control launcher could not find a source checkout, turnkeyai, or npx." >&2
echo "From a source checkout, run: npm run app -- --no-open" >&2
exit 127
