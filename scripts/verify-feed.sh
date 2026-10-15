#!/usr/bin/env bash
# Verifies the Tango update feed the way the app does: fetches latest.yml and latest.yml.sig and
# checks the Ed25519 signature with the public key compiled into the app, then checks that the
# installer and blockmap latest.yml points at are served.
# Usage: scripts/verify-feed.sh [feed-url]   (default http://192.168.1.5:8766/)
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEED="${1:-http://192.168.1.5:8766/}"
FEED="${FEED%/}"
PUBLIC_KEY="${REPO_DIR}/apps/desktop/build/release-public.pem"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

curl -fsS "${FEED}/latest.yml" -o "${TMP}/latest.yml"
curl -fsS "${FEED}/latest.yml.sig" -o "${TMP}/latest.yml.sig"
base64 -d "${TMP}/latest.yml.sig" > "${TMP}/sig.bin"
openssl pkeyutl -verify -pubin -inkey "${PUBLIC_KEY}" -rawin -in "${TMP}/latest.yml" -sigfile "${TMP}/sig.bin"

VERSION="$(sed -n 's/^version: *//p' "${TMP}/latest.yml" | tr -d "'\"")"
INSTALLER="$(sed -n 's/^path: *//p' "${TMP}/latest.yml" | tr -d "'\"")"
echo "feed ${FEED}: version ${VERSION}, installer ${INSTALLER}"
for f in "${INSTALLER}" "${INSTALLER}.blockmap"; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' -I "${FEED}/${f}")"
  echo "  ${f}: HTTP ${code}"
  test "${code}" = 200 || { echo "not served: ${FEED}/${f}" >&2; exit 1; }
done
echo "feed OK"
