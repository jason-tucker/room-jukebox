#!/usr/bin/env bash
# Run a command inside the node:24 dev container (the host has no Node).
# Usage: scripts/dev.sh pnpm install
#        scripts/dev.sh pnpm -r test
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -eq 0 ]; then
  echo "usage: scripts/dev.sh <command...>" >&2
  exit 2
fi
CMD="$(printf '%q ' "$@")"
exec docker run --rm \
  -v "${REPO_DIR}:/work" -w /work \
  -v room-jukebox-pnpm-store:/root/.local/share/pnpm \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -e CI=1 \
  node:24 bash -lc "corepack enable && corepack prepare pnpm@latest --activate && ${CMD}"
