#!/usr/bin/env bash
#
# generate-appcast.sh
# ───────────────────
# Build the signed appcast.xml that Sparkle reads for updates. Run after
# make-dmg.sh has produced a new DMG in ./dist/.
#
# Sparkle's `generate_appcast` tool walks a directory of DMGs, signs each
# one with the EdDSA private key, and emits/updates appcast.xml so it
# lists every release with its signature + URL + length. The DMG's URL
# in the appcast is what installed apps actually download — we set it
# to the GitHub Releases asset URL via --download-url-prefix.
#
# Key handling: generate_appcast normally reads the private key from the
# login keychain. The SPM-distributed Sparkle binary isn't code-signed
# so macOS refuses it keychain access (error -60008). We work around
# this by passing --ed-key-file, pointing at a file the operator
# populates from 1Password just before running and shreds right after.
#
# Usage:
#   1. Open 1Password, copy the Verso Sparkle EdDSA private key
#   2. pbpaste > /tmp/verso-edkey.txt
#   3. ./scripts/release/generate-appcast.sh
#   4. The script shreds /tmp/verso-edkey.txt when done
#
# Output:
#   ./dist/appcast.xml   — drop into frontend/public/ and deploy
#
# Optional env:
#   VERSO_SPARKLE_KEY_FILE   default: /tmp/verso-edkey.txt
#   VERSO_RELEASE_URL_PREFIX default: https://github.com/HugoSanchez/macos-agent-orchestrator/releases/download/
#                            Each DMG ends up at <prefix>v<version>/<dmg-filename>
#                            so you must create the matching GitHub Release tag.
#   VERSO_APPCAST_INCLUDE_DELTAS default: 0
#                            Set to 1 to advertise Sparkle delta updates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/release-paths.sh
source "${SCRIPT_DIR}/../lib/release-paths.sh"
DIST_DIR="${VERSO_RELEASE_DIST}"

KEY_FILE="${VERSO_SPARKLE_KEY_FILE:-/tmp/verso-edkey.txt}"
URL_PREFIX="${VERSO_RELEASE_URL_PREFIX:-https://github.com/HugoSanchez/macos-agent-orchestrator/releases/download/}"
INCLUDE_DELTAS="${VERSO_APPCAST_INCLUDE_DELTAS:-0}"

if [ ! -d "${DIST_DIR}" ] || ! ls "${DIST_DIR}"/verso-*.dmg >/dev/null 2>&1; then
    echo "error: no DMGs found in ${DIST_DIR}" >&2
    echo "       run ./scripts/release/make-dmg.sh first" >&2
    exit 1
fi

if [ ! -s "${KEY_FILE}" ]; then
    echo "error: Sparkle private key file is missing or empty: ${KEY_FILE}" >&2
    echo "       1. open 1Password, copy the Verso Sparkle EdDSA private key" >&2
    echo "       2. pbpaste > ${KEY_FILE}" >&2
    echo "       3. re-run this script" >&2
    exit 1
fi

# Find the generate_appcast tool downloaded by the canonical release build.
# Restricting this search prevents a different checkout's Sparkle binary from
# being selected just because it happened to be returned first by find(1).
GENERATE_APPCAST="$(find "${VERSO_RELEASE_DERIVED_DATA}" \
    -name generate_appcast -type f -not -path '*old_dsa*' 2>/dev/null | head -1)"

if [ -z "${GENERATE_APPCAST}" ] || [ ! -x "${GENERATE_APPCAST}" ]; then
    echo "error: generate_appcast not found under ${VERSO_RELEASE_DERIVED_DATA}" >&2
    echo "       run ./scripts/release/build-managed.sh so SPM downloads Sparkle's tools" >&2
    exit 1
fi

# Shred the key file on exit no matter what.
trap 'if [ -f "${KEY_FILE}" ]; then rm -P "${KEY_FILE}" 2>/dev/null || rm -f "${KEY_FILE}"; fi' EXIT

echo "[appcast] using generate_appcast at ${GENERATE_APPCAST}"
echo "[appcast] signing DMGs in ${DIST_DIR}"
echo "[appcast] release URL prefix: ${URL_PREFIX}"
echo "[appcast] include delta updates: ${INCLUDE_DELTAS}"

# Sparkle appends each artifact filename to the prefix. GitHub also needs a
# per-version tag in the URL, which we insert below after generation.

"${GENERATE_APPCAST}" \
    --ed-key-file "${KEY_FILE}" \
    --download-url-prefix "${URL_PREFIX}" \
    "${DIST_DIR}"

APPCAST="${DIST_DIR}/appcast.xml"
if [ ! -f "${APPCAST}" ]; then
    echo "error: generate_appcast did not produce ${APPCAST}" >&2
    exit 1
fi

# Post-process: insert the per-version tag into each <enclosure url>. We
# match `<URL_PREFIX>verso-<version>.dmg` and rewrite it to
# `<URL_PREFIX>v<version>/verso-<version>.dmg` so the URL matches the
# GitHub Releases convention `releases/download/<tag>/<asset>`.
#
# Use a Python one-liner — sed's regex flavor varies across BSD/GNU and
# we'd rather not chase that.
python3 - "${APPCAST}" "${URL_PREFIX}" "${INCLUDE_DELTAS}" <<'PY'
import re, sys
path, prefix = sys.argv[1], sys.argv[2]
src = open(path).read()
# Match: <prefix>verso-<version>.dmg  →  <prefix>v<version>/verso-<version>.dmg
dmg_pattern = re.compile(rf'({re.escape(prefix)})verso-([\d.]+)\.dmg')
fixed = dmg_pattern.sub(r'\1v\2/verso-\2.dmg', src)

# Delta filenames use Sparkle build numbers (e.g. verso3-2.delta), not
# marketing versions, so infer the GitHub release tag from the enclosing
# item's sparkle:shortVersionString.
item_pattern = re.compile(r'(<item>.*?</item>)', re.S)
short_version_pattern = re.compile(r'<sparkle:shortVersionString>([^<]+)</sparkle:shortVersionString>')
delta_pattern = re.compile(rf'({re.escape(prefix)})(verso\d+-\d+\.delta)')

def fix_item(match):
    item = match.group(1)
    short = short_version_pattern.search(item)
    if not short:
        return item
    tag = f'v{short.group(1)}'
    return delta_pattern.sub(rf'\1{tag}/\2', item)

fixed = item_pattern.sub(fix_item, fixed)
if sys.argv[3] != "1":
    fixed = re.sub(r'\n[ \t]*<sparkle:deltas>.*?</sparkle:deltas>', '', fixed, flags=re.S)
open(path, 'w').write(fixed)
PY

echo "[appcast] appcast written to ${APPCAST}"
echo ""
echo "Next steps:"
echo "  1. Create a GitHub release: gh release create v<version> dist/verso-<version>.dmg"
echo "  2. Copy appcast.xml into frontend/public/appcast.xml"
echo "  3. Deploy frontend so https://www.itsverso.xyz/appcast.xml updates"
