#!/usr/bin/env bash
# Build the official Verso app with managed services enabled. Ordinary Xcode
# Debug/Release builds deliberately embed the OSS-safe local default.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/release-paths.sh
source "${SCRIPT_DIR}/../lib/release-paths.sh"
cd "${VERSO_RELEASE_ROOT}"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

xcodebuild \
    "$@" \
    -project verso.xcodeproj \
    -scheme verso \
    -configuration Release \
    -derivedDataPath "${VERSO_RELEASE_DERIVED_DATA}" \
    VERSO_DEFAULT_RUNTIME_MODE=managed \
    build

info_plist="${VERSO_RELEASE_APP}/Contents/Info.plist"

if [ ! -f "${info_plist}" ]; then
    echo "[managed-release] ERROR: built Info.plist not found at ${info_plist}" >&2
    exit 1
fi

embedded_mode="$(/usr/libexec/PlistBuddy -c 'Print :VersoDefaultRuntimeMode' "${info_plist}")"
if [ "${embedded_mode}" != "managed" ]; then
    echo "[managed-release] ERROR: expected managed mode, found ${embedded_mode}" >&2
    exit 1
fi

for key in VersoManagedBackendURL VersoManagedFrontendURL SentryDSN SUFeedURL SUPublicEDKey; do
    value="$(/usr/libexec/PlistBuddy -c "Print :${key}" "${info_plist}" 2>/dev/null || true)"
    if [ -z "${value}" ]; then
        echo "[managed-release] ERROR: ${key} is missing from the managed app" >&2
        exit 1
    fi
done

echo "[managed-release] built ${VERSO_RELEASE_APP} (mode=managed)"
