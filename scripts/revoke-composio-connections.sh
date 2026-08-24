#!/usr/bin/env bash
#
# Revoke and delete specific Composio connected accounts.
#
# Usage:
#   COMPOSIO_API_KEY=... ./scripts/revoke-composio-connections.sh ca_abc ca_def
#
# The script first asks Composio to revoke OAuth tokens at the upstream
# provider, then deletes the connected account record from Composio.
#
# Failure policy mirrors the production disconnect flow
# (backend/src/composio/connections.ts): 400/409 means the provider cannot
# revoke programmatically and deletion proceeds (manual provider cleanup may
# be needed); 404 means already absent and deletion proceeds idempotently;
# auth, rate-limit, and server failures stop for that account so the
# credential-bearing record stays visible for a retry.

set -euo pipefail

API_BASE="${COMPOSIO_API_BASE:-https://backend.composio.dev/api/v3.1}"
API_KEY="${COMPOSIO_API_KEY:-}"

usage() {
    cat >&2 <<'EOF'
Usage:
  COMPOSIO_API_KEY=... ./scripts/revoke-composio-connections.sh <connected-account-id> [...]

Example:
  COMPOSIO_API_KEY=ak_... ./scripts/revoke-composio-connections.sh ca_abc123 ca_def456

Notes:
  - Use full connected account IDs from the Composio dashboard.
  - The API key must belong to the same Composio project/org as those accounts.
  - Revoke can return 400/409 for toolkits or states that do not support provider-side revocation;
    the script will still attempt DELETE.
EOF
}

if [[ -z "${API_KEY}" ]]; then
    echo "error: COMPOSIO_API_KEY is required." >&2
    usage
    exit 2
fi

if [[ "$#" -eq 0 ]]; then
    echo "error: at least one connected account ID is required." >&2
    usage
    exit 2
fi

request() {
    local method="$1"
    local path="$2"
    local body_file="$3"

    local status
    status="$(
        curl -sS \
            -X "${method}" \
            -H "x-api-key: ${API_KEY}" \
            -H "Accept: application/json" \
            -o "${body_file}" \
            -w "%{http_code}" \
            "${API_BASE}${path}"
    )"
    printf '%s' "${status}"
}

print_body() {
    local body_file="$1"
    if [[ ! -s "${body_file}" ]]; then
        return
    fi
    sed 's/^/    /' "${body_file}"
    printf '\n'
}

is_delete_success() {
    case "$1" in
        200|202|204|404) return 0 ;;
        *) return 1 ;;
    esac
}

failed=0

for connected_account_id in "$@"; do
    if [[ -z "${connected_account_id// }" ]]; then
        continue
    fi

    echo "==> ${connected_account_id}"

    revoke_body="$(mktemp)"
    delete_body="$(mktemp)"
    trap 'rm -f "${revoke_body:-}" "${delete_body:-}"' EXIT

    revoke_status="$(request POST "/connected_accounts/${connected_account_id}/revoke" "${revoke_body}")"
    case "${revoke_status}" in
        200)
            echo "  revoke: ok"
            ;;
        400|409)
            echo "  revoke: unsupported toolkit or non-revokable state (HTTP ${revoke_status}); continuing to delete — the provider grant may need manual removal"
            print_body "${revoke_body}"
            ;;
        404)
            echo "  revoke: account not found (HTTP 404); continuing to delete in case the revoke view is stale"
            print_body "${revoke_body}"
            ;;
        401|403)
            echo "  revoke: authorization failed (HTTP ${revoke_status}); stopping for this account" >&2
            print_body "${revoke_body}" >&2
            failed=1
            rm -f "${revoke_body}" "${delete_body}"
            continue
            ;;
        *)
            # Retryable failure (rate limit / server error): keep the account
            # so the revoke can be retried, matching the production flow.
            echo "  revoke: failed (HTTP ${revoke_status}); stopping for this account so it can be retried" >&2
            print_body "${revoke_body}" >&2
            failed=1
            rm -f "${revoke_body}" "${delete_body}"
            continue
            ;;
    esac

    delete_status="$(request DELETE "/connected_accounts/${connected_account_id}" "${delete_body}")"
    if is_delete_success "${delete_status}"; then
        if [[ "${delete_status}" == "404" ]]; then
            echo "  delete: already gone (HTTP 404)"
        else
            echo "  delete: ok (HTTP ${delete_status})"
        fi
    else
        echo "  delete: failed (HTTP ${delete_status})" >&2
        print_body "${delete_body}" >&2
        failed=1
    fi

    rm -f "${revoke_body}" "${delete_body}"
    echo
done

exit "${failed}"
