#!/usr/bin/env bash
# Build the official Verso app with managed services enabled. Ordinary Xcode
# Debug/Release builds deliberately embed the OSS-safe local default.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

xcodebuild \
    -project verso.xcodeproj \
    -scheme verso \
    -configuration Release \
    VERSO_DEFAULT_RUNTIME_MODE=managed \
    "$@" \
    build

app_path="$(
    xcodebuild \
        -project verso.xcodeproj \
    -scheme verso \
    -configuration Release \
    VERSO_DEFAULT_RUNTIME_MODE=managed \
    "$@" \
    -showBuildSettings \
        2>/dev/null \
        | awk -F ' = ' '
            $1 ~ /^[[:space:]]*TARGET_BUILD_DIR$/ { target=$2 }
            $1 ~ /^[[:space:]]*WRAPPER_NAME$/ { wrapper=$2 }
            END { if (target != "" && wrapper != "") print target "/" wrapper }
        '
)"
info_plist="${app_path}/Contents/Info.plist"

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

echo "[managed-release] built ${app_path} (mode=managed)"
