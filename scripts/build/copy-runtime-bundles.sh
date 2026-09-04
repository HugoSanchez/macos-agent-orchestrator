#!/usr/bin/env bash
#
# copy-runtime-bundles.sh
# ───────────────────────
# Xcode Run Script build phase. Runs at the end of the verso target build.
#
#   • All builds: copy Verso and third-party legal notices into the app.
#
#   • Debug builds: skip runtime components. SidecarManager.swift uses the
#     validated `desktop/runtime-bundles/node` with `desktop/orchestrator/`,
#     then falls back to system Node when no development bundle is available.
#
#   • Release builds: rsyncs desktop/runtime-bundles/ into the .app's
#     Resources/ directory so the shipping bundle contains everything it needs
#     to run on a friend's Mac without `brew install node`.
#
# Inputs (from Xcode):
#   CONFIGURATION                 "Debug" or "Release"
#   SRCROOT                       repo root (xcodeproj sits there)
#   BUILT_PRODUCTS_DIR            wherever Xcode is writing the .app to
#   CONTENTS_FOLDER_PATH          e.g. "verso.app/Contents"
#
# Pre-requisite for Release: ./scripts/build/build-runtime-bundles.sh must have been
# run at least once. The script below fails loudly if desktop/runtime-bundles/
# is missing — much better than producing a silently-broken Release .app.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUNDLE_SRC="${REPO_ROOT}/desktop/runtime-bundles"
RESOURCES_DST="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources"
LEGAL_DST="${RESOURCES_DST}/Legal"

for legal_path in LICENSE THIRD_PARTY_NOTICES.md LICENSES; do
    if [ ! -e "${REPO_ROOT}/${legal_path}" ]; then
        echo "error: required legal notice is missing: ${REPO_ROOT}/${legal_path}" >&2
        exit 1
    fi
done

mkdir -p "${LEGAL_DST}/ThirdParty"
cp "${REPO_ROOT}/LICENSE" "${LEGAL_DST}/Verso-AGPL-3.0-only.txt"
cp "${REPO_ROOT}/THIRD_PARTY_NOTICES.md" "${LEGAL_DST}/THIRD_PARTY_NOTICES.md"
rsync -a --delete "${REPO_ROOT}/LICENSES/" "${LEGAL_DST}/ThirdParty/"

if [ "${CONFIGURATION:-}" != "Release" ]; then
    echo "[copy-bundles] copied legal notices; config=${CONFIGURATION:-unknown}, skipping runtime components"
    exit 0
fi

required_paths=(
    "${BUNDLE_SRC}/node/bin"
    "${BUNDLE_SRC}/node/LICENSE"
    "${BUNDLE_SRC}/orchestrator/node_modules"
    "${BUNDLE_SRC}/python/arm64/python/bin"
    "${BUNDLE_SRC}/python/arm64/python/lib/python3.11/LICENSE.txt"
    "${BUNDLE_SRC}/site-packages/arm64/site-packages"
    "${BUNDLE_SRC}/site-packages/arm64/bin/hermes"
    "${BUNDLE_SRC}/hermes-defaults"
    "${BUNDLE_SRC}/hermes-defaults/skills"
    "${BUNDLE_SRC}/hermes-defaults/optional-skills"
    "${BUNDLE_SRC}/BUNDLE_VERSION"
)
for p in "${required_paths[@]}"; do
    if [ ! -e "${p}" ]; then
        echo "error: desktop/runtime-bundles/ is missing or incomplete (no ${p})." >&2
        echo "       Run: ./scripts/build/build-runtime-bundles.sh" >&2
        echo "       Then rebuild the Release archive." >&2
        exit 1
    fi
done

orchestrator_deps_changed=false
for dep_file in package.json package-lock.json; do
    if ! cmp -s "${REPO_ROOT}/desktop/orchestrator/${dep_file}" "${BUNDLE_SRC}/orchestrator/${dep_file}"; then
        orchestrator_deps_changed=true
    fi
done

echo "[copy-bundles] refreshing orchestrator source snapshot"
rsync -a --delete \
    --exclude 'node_modules' \
    --exclude 'test' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude '*.log' \
    --exclude '.DS_Store' \
    "${REPO_ROOT}/desktop/orchestrator/" "${BUNDLE_SRC}/orchestrator/"

if ${orchestrator_deps_changed}; then
    echo "[copy-bundles] orchestrator dependencies changed, reinstalling bundled node_modules"
    ( cd "${BUNDLE_SRC}/orchestrator" && npm ci --include=dev --no-audit --no-fund --loglevel=error )
fi

if [ -z "$(find "${BUNDLE_SRC}/hermes-defaults/skills" -path '*/SKILL.md' -print -quit)" ]; then
    echo "error: desktop/runtime-bundles/hermes-defaults/skills does not contain any SKILL.md files." >&2
    echo "       Run: ./scripts/build-runtime-bundles.sh" >&2
    echo "       Then rebuild the Release archive." >&2
    exit 1
fi

if [ -z "$(find "${BUNDLE_SRC}/hermes-defaults/optional-skills" -path '*/SKILL.md' -print -quit)" ]; then
    echo "error: desktop/runtime-bundles/hermes-defaults/optional-skills does not contain any SKILL.md files." >&2
    echo "       Run: ./scripts/build-runtime-bundles.sh" >&2
    echo "       Then rebuild the Release archive." >&2
    exit 1
fi

# Wipe any stale wheels/ dir from a previous bundle layout — leaving it would
# bloat the .app and re-introduce the notarization failures that motivated
# the switch to pre-installed site-packages.
rm -rf "${RESOURCES_DST}/wheels"

mkdir -p \
    "${RESOURCES_DST}/node" \
    "${RESOURCES_DST}/orchestrator" \
    "${RESOURCES_DST}/python" \
    "${RESOURCES_DST}/site-packages" \
    "${RESOURCES_DST}/hermes-defaults"

echo "[copy-bundles] copying runtime bundles into ${CONTENTS_FOLDER_PATH}/Resources/"
rsync -a --delete "${BUNDLE_SRC}/node/" "${RESOURCES_DST}/node/"
rsync -a --delete "${BUNDLE_SRC}/orchestrator/" "${RESOURCES_DST}/orchestrator/"
rsync -a --delete "${BUNDLE_SRC}/python/" "${RESOURCES_DST}/python/"
rsync -a --delete "${BUNDLE_SRC}/site-packages/" "${RESOURCES_DST}/site-packages/"
rsync -a --delete "${BUNDLE_SRC}/hermes-defaults/" "${RESOURCES_DST}/hermes-defaults/"
cp "${BUNDLE_SRC}/BUNDLE_VERSION" "${RESOURCES_DST}/BUNDLE_VERSION"

echo "[copy-bundles] done"
