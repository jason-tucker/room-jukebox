#!/usr/bin/env bash
# Cross-build the Windows NSIS installer on Tango (Linux + Wine, no Node on the host).
#   1. builds web + desktop bundles in the node:24 dev container (scripts/dev.sh)
#   2. runs electron-builder --win --x64 in electronuserland/builder:wine
#   3. copies RoomJukebox-Setup-<version>.exe and latest.yml to /mnt/user/Public/RoomJukebox
# Unsigned, never publishes. Usage: scripts/build-win.sh   (OUT_DIR=... to override the copy target)
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-/mnt/user/Public/RoomJukebox}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "${REPO_DIR}/package.json")"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${REPO_DIR}/apps/desktop/package.json" | head -1)"

cd "${REPO_DIR}"
scripts/dev.sh pnpm --filter desktop build

rm -rf apps/desktop/release
docker run --rm \
  -v "${REPO_DIR}:/project" -w /project \
  -v room-jukebox-pnpm-store:/root/.local/share/pnpm \
  -v room-jukebox-electron-cache:/root/.cache/electron \
  -v room-jukebox-electron-builder-cache:/root/.cache/electron-builder \
  -e CI=1 \
  electronuserland/builder:wine \
  bash -lc "corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && cd apps/desktop && pnpm exec electron-builder --win --x64 --publish never"

INSTALLER="apps/desktop/release/RoomJukebox-Setup-${VERSION}.exe"
test -f "${INSTALLER}" || { echo "installer not found: ${INSTALLER}" >&2; exit 1; }

mkdir -p "${OUT_DIR}"
cp "${INSTALLER}" apps/desktop/release/latest.yml "${OUT_DIR}/"
chown nobody:users "${OUT_DIR}" "${OUT_DIR}/$(basename "${INSTALLER}")" "${OUT_DIR}/latest.yml"
chmod 666 "${OUT_DIR}/$(basename "${INSTALLER}")" "${OUT_DIR}/latest.yml"
ls -l "${OUT_DIR}"
