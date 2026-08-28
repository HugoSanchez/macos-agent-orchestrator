#!/usr/bin/env bash
# Launch a release candidate with isolated Verso/Hermes state. This leaves the
# developer's real application support, Hermes home, preferences, and managed
# session Keychain item untouched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/release-paths.sh
source "${SCRIPT_DIR}/../lib/release-paths.sh"

COMMAND="${1:-help}"
TEST_ROOT="${VERSO_RELEASE_TEST_ROOT:-${HOME}/.verso-release-test}"
ACTIVE_FILE="${TEST_ROOT}/active"

usage() {
    cat <<EOF
Usage:
  ./scripts/qa/fresh-install.sh start [path/to/verso.app]
  ./scripts/qa/fresh-install.sh status
  ./scripts/qa/fresh-install.sh stop

The default app is:
  ${VERSO_RELEASE_APP}

Each run uses disposable state below ${TEST_ROOT}. No production Verso or
Hermes data is moved or deleted.
EOF
}

quit_verso() {
    osascript -e 'tell application id "xyz.itsverso.app" to quit' 2>/dev/null || true
}

active_run() {
    [ -f "${ACTIVE_FILE}" ] || return 1
    local run_dir
    run_dir="$(cat "${ACTIVE_FILE}")"
    case "${run_dir}" in
        "${TEST_ROOT}"/*) printf '%s\n' "${run_dir}" ;;
        *)
            echo "error: refusing invalid active test path: ${run_dir}" >&2
            exit 1
            ;;
    esac
}

start() {
    local app_path="${2:-${VERSO_RELEASE_APP}}"
    local run_dir

    if active_run >/dev/null; then
        echo "error: a release test is already active; run 'stop' first" >&2
        exit 1
    fi
    if [ ! -d "${app_path}" ]; then
        echo "error: app bundle not found at ${app_path}" >&2
        echo "       run ./scripts/release/build-managed.sh first" >&2
        exit 1
    fi
    if ! codesign --verify --deep --strict "${app_path}"; then
        echo "error: release candidate has an invalid code signature: ${app_path}" >&2
        exit 1
    fi

    quit_verso
    run_dir="${TEST_ROOT}/$(date -u +%Y%m%d-%H%M%S)"
    mkdir -p "${run_dir}/home" "${run_dir}/state" "${run_dir}/hermes" "${run_dir}/legacy"
    printf '%s\n' "${run_dir}" > "${ACTIVE_FILE}"

    echo "[fresh-install] launching ${app_path}"
    echo "[fresh-install] isolated state: ${run_dir}"
    if ! open -F -n \
        --env "CFFIXED_USER_HOME=${run_dir}/home" \
        --env "HOME=${run_dir}/home" \
        --env "VERSO_RUNTIME_MODE=managed" \
        --env "VERSO_SKIP_MANAGED_SESSION_KEYCHAIN=1" \
        --env "VERSO_LOCAL_STATE_ROOT=${run_dir}/state" \
        --env "VERSO_HERMES_HOME=${run_dir}/hermes" \
        --env "VERSO_LEGACY_CHAT_STORE_PATH=${run_dir}/legacy/chat-sessions.sqlite" \
        --env "VERSO_LEGACY_CONNECTIONS_STORE_PATH=${run_dir}/legacy/connections.json" \
        --env "VERSO_LEGACY_COMPOSIO_TOOLS_REFRESH_MARKER_PATH=${run_dir}/legacy/composio-tools-refresh.marker" \
        "${app_path}"; then
        rm -f "${ACTIVE_FILE}"
        exit 1
    fi

    echo "[fresh-install] test the release, then run: ./scripts/qa/fresh-install.sh stop"
}

status() {
    local run_dir
    if run_dir="$(active_run)"; then
        echo "release test active: ${run_dir}"
    else
        echo "no active release test"
    fi
}

stop() {
    local run_dir
    if ! run_dir="$(active_run)"; then
        echo "no active release test"
        return
    fi
    quit_verso
    rm -rf -- "${run_dir}"
    rm -f "${ACTIVE_FILE}"
    echo "[fresh-install] removed isolated test state: ${run_dir}"
}

case "${COMMAND}" in
    start) start "$@" ;;
    status) status ;;
    stop) stop ;;
    help|--help|-h) usage ;;
    *)
        usage >&2
        exit 2
        ;;
esac
