# smoke-gateway-checks.sh — shared assertions for the Hermes gateway smoke
# harnesses: scripts/smoke-test-hermes-bundle.sh (shipped bundle) and the
# hermes-runtime-smoke job in .github/workflows/ci.yml (pinned ref). Both
# apply the same runtime patches, so they must assert the same contract —
# this file is that contract, in one place.
#
# Callers boot a patched gateway, then source this file with these set:
#   SMOKE_PORT     gateway port
#   SMOKE_API_KEY  API_SERVER_KEY the gateway was started with
#   SMOKE_PID      gateway process id
#   SMOKE_LOG      gateway stdout/stderr log file
#   SMOKE_HOME     HERMES_HOME of the gateway (for logs/errors.log)
#   SMOKE_TMP      scratch dir for response bodies
# Functions return non-zero on failure; callers run under `set -e`.

smoke_fail() {
    echo "[smoke] FAIL: $1" >&2
}

smoke_wait_for_gateway() {  # $1: timeout seconds (default 90)
    local timeout="${1:-90}"
    local deadline=$(( $(date +%s) + timeout ))
    until curl -sf -o /dev/null -H "Authorization: Bearer ${SMOKE_API_KEY}" \
            "http://127.0.0.1:${SMOKE_PORT}/v1/models"; do
        if ! kill -0 "${SMOKE_PID}" 2>/dev/null; then
            smoke_fail "gateway process died during startup; log tail:"
            tail -40 "${SMOKE_LOG}" >&2
            return 1
        fi
        if [ "$(date +%s)" -ge "${deadline}" ]; then
            smoke_fail "gateway did not become ready within ${timeout}s; log tail:"
            tail -40 "${SMOKE_LOG}" >&2
            return 1
        fi
        sleep 2
    done
}

# One streaming POST /v1/responses — the request shape the orchestrator sends
# for every chat message, including the per-request model/reasoning overrides
# so the verso-request-overrides code path runs. A healthy handler answers
# HTTP 200 with SSE reaching a terminal event (response.failed is fine —
# provider auth errors happen inside the agent, and smoke runs have no model
# credentials); a mis-anchored patch answers a raw 500 before the stream.
smoke_assert_streaming_responses() {  # $1: conversation id
    local body response_file status terminal
    body='{"input":"smoke test","conversation":"'"$1"'","truncation":"auto","stream":true,"store":true,"model":"gpt-5.5","reasoning":{"effort":"low"}}'
    response_file="${SMOKE_TMP}/smoke-response.txt"
    status="$(curl -s -N --max-time 60 -o "${response_file}" -w "%{http_code}" \
        -X POST "http://127.0.0.1:${SMOKE_PORT}/v1/responses" \
        -H "Authorization: Bearer ${SMOKE_API_KEY}" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d "${body}")" || status="000"

    if [ "${status}" != "200" ]; then
        smoke_fail "/v1/responses returned HTTP ${status} (expected 200 + SSE)"
        echo "[smoke] response body:" >&2
        head -5 "${response_file}" >&2
        echo "[smoke] gateway errors:" >&2
        tail -30 "${SMOKE_HOME}/logs/errors.log" 2>/dev/null >&2 || tail -20 "${SMOKE_LOG}" >&2
        return 1
    fi
    if ! grep -q "^event: " "${response_file}"; then
        smoke_fail "HTTP 200 but no SSE events in response"
        head -5 "${response_file}" >&2
        return 1
    fi
    if ! grep -Eq "^event: response\.(completed|failed)" "${response_file}"; then
        smoke_fail "SSE stream never reached a terminal event"
        grep "^event: " "${response_file}" >&2
        return 1
    fi
    terminal="$(grep -Eo "^event: response\.(completed|failed)" "${response_file}" | tail -1)"
    echo "[smoke] PASS: HTTP 200, SSE stream terminated with ${terminal#event: }"
    echo "[smoke] (response.failed is expected without model credentials — the handler is healthy either way)"
}

# Verso is self-contained and cannot lazy-install missing pieces after release.
# Keep this small list as the product's bundle contract: every API-server tool
# must register, and credential-free baseline capabilities must be advertised
# from a virgin home. Provider-specific tools may remain gated until configured.
smoke_assert_runtime_capabilities() {
    local python_bin="${SMOKE_PYTHON:-python3}"
    local python_path="${SMOKE_PYTHONPATH:-}"
    echo "[smoke] checking bundled runtime capability contract"

    if ! HERMES_HOME="${SMOKE_HOME}" PYTHONPATH="${python_path}" "${python_bin}" -m pip check; then
        smoke_fail "bundled Python dependency graph is inconsistent"
        return 1
    fi

    if ! HERMES_HOME="${SMOKE_HOME}" PYTHONPATH="${python_path}" "${python_bin}" - <<'PYEOF'
import importlib.util

import model_tools  # noqa: F401 — discovers built-in tools and plugins
from agent.web_search_registry import get_active_search_provider, get_provider
from toolsets import resolve_toolset
from tools import web_tools
from tools.registry import registry

# Verso-owned manifest. This intentionally does not include every optional
# Hermes provider dependency; it covers the complete tool surface Verso ships
# plus the credential-free capabilities a fresh install promises.
required_imports = {"ddgs"}
required_registered_tools = {
    "web_search", "web_extract",
    "terminal", "process",
    "read_file", "write_file", "patch", "search_files",
    "vision_analyze", "image_generate",
    "skills_list", "skill_view", "skill_manage",
    "browser_navigate", "browser_snapshot", "browser_click",
    "browser_type", "browser_scroll", "browser_back", "browser_press",
    "browser_get_images", "browser_vision", "browser_console",
    "browser_cdp", "browser_dialog",
    "todo", "memory", "session_search",
    "execute_code", "delegate_task", "cronjob",
    "ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service",
}
required_available_tools = {
    "web_search", "web_extract",
    "terminal", "process",
    "read_file", "write_file", "patch", "search_files",
    "skills_list", "skill_view", "skill_manage",
    "todo", "memory", "session_search",
    "execute_code", "delegate_task",
}

missing_imports = sorted(name for name in required_imports if importlib.util.find_spec(name) is None)
assert not missing_imports, f"missing required Python imports: {missing_imports}"

declared_api_tools = set(resolve_toolset("hermes-api-server"))
assert required_registered_tools == declared_api_tools, (
    "Hermes API-server toolset changed; review and update the Verso bundle contract: "
    f"added={sorted(declared_api_tools - required_registered_tools)}, "
    f"removed={sorted(required_registered_tools - declared_api_tools)}"
)

registered = set(registry.get_all_tool_names())
missing_registered = sorted(required_registered_tools - registered)
assert not missing_registered, f"required tools did not register: {missing_registered}"

available = {
    definition["function"]["name"]
    for definition in registry.get_definitions(required_available_tools, quiet=True)
}
missing_available = sorted(required_available_tools - available)
assert not missing_available, f"required baseline tools are unavailable: {missing_available}"

web_tools._ensure_web_plugins_loaded()
provider = get_active_search_provider()
ddgs_provider = get_provider("ddgs")

assert ddgs_provider is not None, "DDGS provider is not registered"
assert ddgs_provider.is_available(), "DDGS provider is not available"
assert provider is not None, "no active web-search provider"
assert web_tools.check_web_api_key(), "web_search availability check returned false"
PYEOF
    then
        smoke_fail "bundled runtime capability contract failed"
        return 1
    fi

    echo "[smoke] PASS: dependencies, registered tools, and baseline capabilities are complete"
}

# MCP OAuth routes added by verso-gateway-mcp-oauth.patch. A mis-anchored or
# missing patch means aiohttp's default 404 on all of them; a healthy patch is
# distinguishable on each route without running a real OAuth flow:
#   - flows/<id> unauthenticated  → 401 (route exists, auth enforced;
#                                   missing route would 404)
#   - callback/<name>             → 404 BUT with the handler's own
#                                   "OAuth flow expired" body, not aiohttp's
#                                   default "404: Not Found"
#   - servers/<name>/auth (auth'd)→ handler JSON "Server ... not found"
#   - tools (auth'd)              → registry JSON with a "servers" map
smoke_assert_mcp_oauth_routes() {
    local flows_status callback_body auth_body auth_status tools_status tools_body
    echo "[smoke] checking MCP OAuth routes from the runtime patch"

    flows_status="$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SMOKE_PORT}/api/mcp/oauth/flows/smoke-nonexistent")" || flows_status="000"
    if [ "${flows_status}" != "401" ]; then
        smoke_fail "GET /api/mcp/oauth/flows/… unauthenticated returned ${flows_status} (expected 401; 404 means verso-gateway-mcp-oauth.patch did not register its routes)"
        return 1
    fi

    callback_body="${SMOKE_TMP}/smoke-oauth-callback.txt"
    if ! curl -s --max-time 10 -o "${callback_body}" "http://127.0.0.1:${SMOKE_PORT}/api/mcp/oauth/callback/smoke_nonexistent?state=abc"; then
        smoke_fail "OAuth callback route did not respond"
        return 1
    fi
    if ! grep -q "OAuth flow expired" "${callback_body}"; then
        smoke_fail "OAuth callback route did not answer with the patch's handler; body:"
        head -3 "${callback_body}" >&2
        return 1
    fi

    auth_body="${SMOKE_TMP}/smoke-oauth-start.txt"
    auth_status="$(curl -s --max-time 10 -o "${auth_body}" -w "%{http_code}" -X POST \
        -H "Authorization: Bearer ${SMOKE_API_KEY}" \
        "http://127.0.0.1:${SMOKE_PORT}/api/mcp/servers/smoke_nonexistent/auth")" || auth_status="000"
    if [ "${auth_status}" != "404" ] || ! grep -q "not found" "${auth_body}"; then
        smoke_fail "POST /api/mcp/servers/…/auth returned ${auth_status}; body:"
        head -3 "${auth_body}" >&2
        return 1
    fi

    tools_status="$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SMOKE_PORT}/api/mcp/tools")" || tools_status="000"
    if [ "${tools_status}" != "401" ]; then
        smoke_fail "GET /api/mcp/tools unauthenticated returned ${tools_status} (expected 401; 404 means the registry route is missing — connector status will never show connected)"
        return 1
    fi
    tools_body="${SMOKE_TMP}/smoke-mcp-tools.txt"
    if ! curl -s --max-time 10 -o "${tools_body}" -H "Authorization: Bearer ${SMOKE_API_KEY}" "http://127.0.0.1:${SMOKE_PORT}/api/mcp/tools"; then
        smoke_fail "/api/mcp/tools did not respond"
        return 1
    fi
    if ! grep -q '"servers"' "${tools_body}"; then
        smoke_fail "/api/mcp/tools did not return a servers map; body:"
        head -3 "${tools_body}" >&2
        return 1
    fi
    echo "[smoke] PASS: MCP OAuth routes registered and dispatching"
}
