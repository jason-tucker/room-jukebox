#!/usr/bin/env bash
# Cross-build the Windows NSIS installer on Tango (Linux + Wine, no Node on the host) and publish
# it to the Tango update feed (/mnt/user/Public/RoomJukebox, served at http://192.168.1.5:8766/).
#   1. writes apps/desktop/build/release-notes.json from docs/RELEASES.md (scripts/release-notes.mjs)
#   2. builds web + desktop bundles in the node:24 dev container (scripts/dev.sh)
#   3. runs electron-builder --win --x64 in electronuserland/builder:wine
#   4. adds `releaseNotes` to latest.yml, signs it (Ed25519, host openssl) -> latest.yml.sig
#   5. copies the installer, its .blockmap, latest.yml and latest.yml.sig to OUT_DIR and deletes
#      older installers there
# Authenticode-unsigned, never publishes to GitHub. Usage: scripts/build-win.sh
#   OUT_DIR=...      copy target (default /mnt/user/Public/RoomJukebox)
#   SIGNING_KEY=...  Ed25519 private key (default /root/.ssh/jukebox_release_signing.pem)
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-/mnt/user/Public/RoomJukebox}"
SIGNING_KEY="${SIGNING_KEY:-/root/.ssh/jukebox_release_signing.pem}"
PUBLIC_KEY="${REPO_DIR}/apps/desktop/build/release-public.pem"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "${REPO_DIR}/package.json")"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${REPO_DIR}/apps/desktop/package.json" | head -1)"

cd "${REPO_DIR}"

# Fail before the long build: the key must exist and match the public key compiled into the app.
test -r "${SIGNING_KEY}" || { echo "signing key not readable: ${SIGNING_KEY}" >&2; exit 1; }
if ! cmp -s <(openssl pkey -in "${SIGNING_KEY}" -pubout 2>/dev/null) "${PUBLIC_KEY}"; then
  echo "signing key does not match ${PUBLIC_KEY}" >&2
  exit 1
fi

scripts/dev.sh node scripts/release-notes.mjs
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

RELEASE_DIR="apps/desktop/release"
INSTALLER_NAME="RoomJukebox-Setup-${VERSION}.exe"
INSTALLER="${RELEASE_DIR}/${INSTALLER_NAME}"
BLOCKMAP="${INSTALLER}.blockmap"
LATEST="${RELEASE_DIR}/latest.yml"
for f in "${INSTALLER}" "${BLOCKMAP}" "${LATEST}"; do
  test -f "${f}" || { echo "build output not found: ${f}" >&2; exit 1; }
done

# releaseNotes goes in before signing: the signature covers the exact bytes the app downloads.
scripts/dev.sh node scripts/release-notes.mjs --latest-yml "${LATEST}"
openssl pkeyutl -sign -inkey "${SIGNING_KEY}" -rawin -in "${LATEST}" | base64 -w0 > "${LATEST}.sig"
openssl pkeyutl -verify -pubin -inkey "${PUBLIC_KEY}" -rawin -in "${LATEST}" \
  -sigfile <(base64 -d "${LATEST}.sig") >/dev/null || { echo "latest.yml.sig does not verify" >&2; exit 1; }

mkdir -p "${OUT_DIR}"
# Installers first, the feed files last: a client never sees a latest.yml without its installer.
cp "${INSTALLER}" "${BLOCKMAP}" "${OUT_DIR}/"
cp "${LATEST}" "${LATEST}.sig" "${OUT_DIR}/"
find "${OUT_DIR}" -maxdepth 1 -type f \( -name 'RoomJukebox-Setup-*.exe' -o -name 'RoomJukebox-Setup-*.exe.blockmap' \) \
  ! -name "${INSTALLER_NAME}" ! -name "${INSTALLER_NAME}.blockmap" -print -delete
for f in "${INSTALLER_NAME}" "${INSTALLER_NAME}.blockmap" latest.yml latest.yml.sig; do
  chown nobody:users "${OUT_DIR}/${f}"
  chmod 666 "${OUT_DIR}/${f}"
done
chown nobody:users "${OUT_DIR}"
ls -l "${OUT_DIR}"
echo "published ${VERSION} to ${OUT_DIR}; check it with scripts/verify-feed.sh"
