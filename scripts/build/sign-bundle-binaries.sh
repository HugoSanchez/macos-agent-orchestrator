#!/usr/bin/env bash
#
# sign-bundle-binaries.sh
# ───────────────────────
# Xcode Run Script build phase. After Bundle Runtime Components copies the
# node + python + orchestrator + site-packages artifacts into Resources/,
# this script signs every Mach-O binary under Resources/ AND inside the
# embedded Sparkle.framework with our Developer ID identity + hardened
# runtime + entitlements. Xcode's own signing step then re-signs the outer
# .app last, which is the order codesign requires.
#
#   • Debug builds: no-op. Local "Sign to Run Locally" ad-hoc signature
#     is good enough for Cmd+R.
#
#   • Release builds: signs every node / python / *.dylib / *.so found
#     under $RESOURCES, plus the four nested binaries inside
#     Frameworks/Sparkle.framework/ (Updater.app, Autoupdate,
#     Downloader.xpc, Installer.xpc), with the same identity + entitlements
#     Xcode uses for the outer app.
#
# Sparkle ships its nested binaries with Sparkle's own ad-hoc signature.
# Apple notarization requires every Mach-O in our bundle to be signed by
# OUR Developer ID with a secure timestamp — so we re-sign them here. The
# Sparkle framework documents this pattern: third-party embedders MUST
# re-sign the nested binaries when shipping outside the Mac App Store.

set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
    echo "[sign-bundles] config=${CONFIGURATION:-unknown}, skipping"
    exit 0
fi

IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY_NAME:-${CODE_SIGN_IDENTITY:-}}"
if [ -z "${IDENTITY}" ] || [ "${IDENTITY}" = "-" ]; then
    echo "[sign-bundles] no Developer ID identity configured (got '${IDENTITY:-empty}'), skipping" >&2
    echo "                hint: set CODE_SIGN_IDENTITY=\"Developer ID Application\" in the Release build settings" >&2
    exit 0
fi

ENTITLEMENTS_REL="${CODE_SIGN_ENTITLEMENTS:-}"
if [ -z "${ENTITLEMENTS_REL}" ] || [ ! -f "${SRCROOT}/${ENTITLEMENTS_REL}" ]; then
    echo "[sign-bundles] entitlements file missing: ${SRCROOT}/${ENTITLEMENTS_REL:-<unset>}" >&2
    exit 1
fi
ENTITLEMENTS="${SRCROOT}/${ENTITLEMENTS_REL}"

CONTENTS="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}"
RESOURCES="${CONTENTS}/Resources"
if [ ! -d "${RESOURCES}" ]; then
    echo "[sign-bundles] Resources dir not found: ${RESOURCES}" >&2
    exit 1
fi

echo "[sign-bundles] identity: ${IDENTITY}"

# ── Collect candidate Mach-O files ───────────────────────────────────────────
# Resources/ holds everything we install: node binary, the per-arch CPython
# tree, every .so / .dylib inside site-packages/, plus orchestrator's
# native node-modules (esbuild, fsevents, etc.). We walk everything and let
# `file(1)` decide what's Mach-O.
#
# NOTE: Sparkle.framework is NOT signed here. Xcode embeds it AFTER this
# script runs, so on clean builds the framework directory doesn't even
# exist yet. notarize-app.sh re-signs Sparkle's nested binaries +
# re-seals the framework + re-signs the outer .app as part of its
# pre-submit pipeline (see that script for details).

candidates_file="$(mktemp)"
trap 'rm -f "${candidates_file}"' EXIT

echo "[sign-bundles] scanning ${RESOURCES} for Mach-O binaries"
find "${RESOURCES}" \
    -path '*/__pycache__' -prune -o \
    \( -name '*.dylib' -o -name '*.so' -o -type f \) -print > "${candidates_file}"

# Filter to actual Mach-O files. `file -b` is fast and skips the bash scripts
# in node_modules/.bin that have +x but aren't Mach-O.
binaries=()
while IFS= read -r path; do
    if [ ! -f "${path}" ]; then continue; fi
    kind="$(/usr/bin/file -b "${path}" 2>/dev/null || echo "")"
    case "${kind}" in
        *Mach-O*)
            binaries+=("${path}")
            ;;
    esac
done < "${candidates_file}"

count=${#binaries[@]}
echo "[sign-bundles] signing ${count} binaries"

# Sort the work: dylibs/.so first (deepest dependencies), then everything
# else. codesign permits any order for siblings, but Apple's guidance is
# deep-first because it surfaces dependency-chain failures earlier.
sorted=()
for b in "${binaries[@]}"; do
    case "${b}" in
        *.dylib|*.so) sorted+=("${b}") ;;
    esac
done
for b in "${binaries[@]}"; do
    case "${b}" in
        *.dylib|*.so) ;;
        *) sorted+=("${b}") ;;
    esac
done

for path in "${sorted[@]}"; do
    /usr/bin/codesign \
        --force \
        --sign "${IDENTITY}" \
        --options runtime \
        --entitlements "${ENTITLEMENTS}" \
        --timestamp \
        "${path}" 2>&1 | sed 's/^/[sign-bundles]   /'
done

echo "[sign-bundles] done — signed ${count} binaries"
