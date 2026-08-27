#!/usr/bin/env bash
#
# smoke-test-hermes-bundle.sh
# ───────────────────────────
# Boots the Hermes gateway straight from desktop/runtime-bundles/ (the exact
# bytes that ship inside Verso.app) with a throwaway HERMES_HOME and drives one
# streaming POST /v1/responses — the same request shape the orchestrator sends
# for every chat message.
#
# Why this exists: "patches apply cleanly + modules byte-compile" does not
# catch a mis-anchored hunk. The 1.0.15 release shipped with
# verso-request-overrides.patch passing kwargs to a function that doesn't
# accept them — a TypeError on every streaming request, i.e. every chat
# message returned HTTP 500 for every user. This script fails on that class
# of bug in ~30 seconds, with no model credentials required: a healthy
# handler answers HTTP 200 with SSE events (response.failed is fine — provider
# auth errors happen inside the agent); a broken handler answers a raw 500
# before the stream starts.
#
# Run after build-runtime-bundles.sh, before archiving a Release build:
#   ./scripts/build-runtime-bundles.sh && ./scripts/smoke-test-hermes-bundle.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUNDLE_DIR="${REPO_ROOT}/desktop/runtime-bundles"

ARCH="arm64"
PYTHON_BIN="${BUNDLE_DIR}/python/${ARCH}/python/bin/python3.11"
SITE_PACKAGES="${BUNDLE_DIR}/site-packages/${ARCH}/site-packages"
HERMES_SCRIPT="${BUNDLE_DIR}/site-packages/${ARCH}/bin/hermes"
DEFAULTS_DIR="${BUNDLE_DIR}/hermes-defaults"

for path in "${PYTHON_BIN}" "${SITE_PACKAGES}" "${HERMES_SCRIPT}" "${DEFAULTS_DIR}/config.yaml"; do
    if [ ! -e "${path}" ]; then
        echo "[smoke] ERROR: missing ${path} — run ./scripts/build-runtime-bundles.sh first" >&2
        exit 1
    fi
done

PORT="${SMOKE_PORT:-18977}"
API_KEY="$(openssl rand -hex 32)"
HOME_DIR="$(mktemp -d /tmp/verso-smoke-hermes-home.XXXXXX)"
LOG_FILE="${HOME_DIR}/smoke-gateway.log"
GATEWAY_PID=""

# shellcheck source=lib/smoke-gateway-checks.sh
source "${SCRIPT_DIR}/lib/smoke-gateway-checks.sh"

cleanup() {
    if [ -n "${GATEWAY_PID}" ] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
        kill "${GATEWAY_PID}" 2>/dev/null || true
        wait "${GATEWAY_PID}" 2>/dev/null || true
    fi
    rm -rf "${HOME_DIR}"
}
trap cleanup EXIT

# Seed a virgin home the same way the supervisor does on first launch. No
# auth.json on purpose — the smoke test asserts handler health, not provider
# reachability.
cp "${DEFAULTS_DIR}/config.yaml" "${HOME_DIR}/config.yaml"
cp "${DEFAULTS_DIR}/SOUL.md" "${HOME_DIR}/SOUL.md" 2>/dev/null || true
mkdir -p "${HOME_DIR}/memories"

echo "[smoke] starting bundled gateway (port ${PORT}, home ${HOME_DIR})"
HERMES_HOME="${HOME_DIR}" \
PYTHONPATH="${SITE_PACKAGES}" \
PYTHONUNBUFFERED=1 \
API_SERVER_ENABLED=true \
API_SERVER_HOST=127.0.0.1 \
API_SERVER_PORT="${PORT}" \
API_SERVER_KEY="${API_KEY}" \
    "${PYTHON_BIN}" "${HERMES_SCRIPT}" gateway run > "${LOG_FILE}" 2>&1 &
GATEWAY_PID=$!

SMOKE_PORT="${PORT}" SMOKE_API_KEY="${API_KEY}" SMOKE_PID="${GATEWAY_PID}"
SMOKE_LOG="${LOG_FILE}" SMOKE_HOME="${HOME_DIR}" SMOKE_TMP="${HOME_DIR}"
smoke_wait_for_gateway 90
echo "[smoke] gateway ready; sending streaming /v1/responses request"

smoke_assert_streaming_responses "smoke-test-1"
smoke_assert_mcp_oauth_routes

# ── Pin-liveness contract ────────────────────────────────────────────────
# Hermes silently ignores pinned tool names that match nothing registered,
# so a drift in the MCP naming convention (0.19 renamed mcp_verso_* to
# mcp__verso__*) strips memory/product-core tools from the model with no
# error anywhere. Ask THIS bundle's own naming function what wire name each
# core tool gets, and assert the orchestrator's pinned list contains it.
echo "[smoke] checking pinned-tool naming contract against the bundle"
CORE_TOOLS="request_connection search_toolkits list_connections get_connection_status propose_message_draft search_memory get_memory_page write_memory_page"

expected_names="$(PYTHONPATH="${SITE_PACKAGES}" "${PYTHON_BIN}" - "${CORE_TOOLS}" <<'PYEOF'
import sys
try:
    from tools.mcp_tool import mcp_prefixed_tool_name
except ImportError:  # pre-0.19 bundles: single-underscore convention
    def mcp_prefixed_tool_name(server, tool):
        return f"mcp_{server}_{tool}"
for tool in sys.argv[1].split():
    print(mcp_prefixed_tool_name("verso", tool))
PYEOF
)"

NODE_BIN="${BUNDLE_DIR}/node/bin/node"
if [ ! -x "${NODE_BIN}" ]; then
    echo "[smoke] ERROR: missing ${NODE_BIN} — run ./scripts/build-runtime-bundles.sh first" >&2
    exit 1
fi
pinned_names="$("${NODE_BIN}" --experimental-strip-types --no-warnings -e "
import('${REPO_ROOT}/desktop/orchestrator/src/hermes/hermes-pinned-tools.ts').then((m) => {
  console.log(m.computePinnedToolNames('/nonexistent-manifest', { includeMemoryTools: true }).join('\n'));
});")"

missing=""
while IFS= read -r name; do
    if ! printf '%s\n' "${pinned_names}" | grep -qx "${name}"; then
        missing="${missing} ${name}"
    fi
done <<< "${expected_names}"

if [ -n "${missing}" ]; then
    echo "[smoke] FAIL: bundle registers core tools under names the orchestrator does not pin:${missing}" >&2
    echo "[smoke] update PIN_PREFIXES in desktop/orchestrator/src/hermes/hermes-pinned-tools.ts" >&2
    exit 1
fi
echo "[smoke] PASS: all core pins match the bundle's MCP naming convention"

# Record the pass, keyed to the exact site-packages build we just validated.
# The marker is a copy of the venv stage's .stamp; a rebuild wipes the arch
# dir (marker included), so a stale pass can never vouch for new bytes.
# make-dmg.sh refuses to package an .app whose embedded stamp has no
# matching smoke pass.
stamp_file="${BUNDLE_DIR}/site-packages/${ARCH}/.stamp"
if [ -f "${stamp_file}" ]; then
    cp "${stamp_file}" "${BUNDLE_DIR}/site-packages/${ARCH}/.smoke-pass"
    echo "[smoke] recorded pass marker for bundle stamp"
fi
