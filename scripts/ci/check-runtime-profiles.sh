#!/usr/bin/env bash
# Verify that ordinary source builds stay local while the official build can
# select managed explicitly. This does not launch the app or contact services.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

read_mode() {
    xcodebuild \
        -project verso.xcodeproj \
        -scheme verso \
        -configuration "$1" \
        ${2:-} \
        -showBuildSettings \
        CODE_SIGNING_ALLOWED=NO \
        2>/dev/null \
        | awk -F ' = ' '$1 ~ /^[[:space:]]*VERSO_DEFAULT_RUNTIME_MODE$/ { value=$2 } END { print value }'
}

for configuration in Debug Release; do
    mode="$(read_mode "${configuration}")"
    if [ "${mode}" != "local" ]; then
        echo "runtime-profiles: ${configuration} defaults to ${mode:-missing}, expected local" >&2
        exit 1
    fi
done

managed_mode="$(read_mode Release VERSO_DEFAULT_RUNTIME_MODE=managed)"
if [ "${managed_mode}" != "managed" ]; then
    echo "runtime-profiles: managed Release override resolved to ${managed_mode:-missing}" >&2
    exit 1
fi

grep -q 'VERSO_RUN_PROFILE=local ./scripts/conductor/run-verso.sh' .conductor/settings.toml \
    || { echo 'runtime-profiles: shared Conductor action is not local' >&2; exit 1; }
grep -q 'VERSO_DEFAULT_RUNTIME_MODE=managed' scripts/release/build-managed.sh \
    || { echo 'runtime-profiles: managed release wrapper is not explicit' >&2; exit 1; }

echo "runtime-profiles: passed"
