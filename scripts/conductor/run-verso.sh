#!/usr/bin/env bash
#
# Build and run the macOS app under Conductor control. Keep the app in the
# foreground so Conductor Stop can terminate the process it launched.

set -euo pipefail

WORKSPACE_PATH="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"
cd "${WORKSPACE_PATH}"

export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"

VERSO_RUN_PROFILE="${VERSO_RUN_PROFILE:-managed}"
case "${VERSO_RUN_PROFILE}" in
    managed|local|byo) ;;
    *)
        echo "[conductor-run] ERROR: unsupported VERSO_RUN_PROFILE=${VERSO_RUN_PROFILE}" >&2
        exit 1
        ;;
esac

# A past debugging session left stale VERSO_* overrides in the launchd
# environment, silently pointing Debug builds at an old Release bundle in
# Xcode DerivedData — the perennial "hermes fails to load after every
# build". Scrub every inherited override before installing this run's known
# good product-like configuration. Dropping VERSO_SKIP_MANAGED_SESSION_KEYCHAIN
# also keeps sign-ins persistent in Keychain across rebuilds (macOS may ask
# once to approve Keychain access after an ad-hoc build).
unset VERSO_BUNDLED_PYTHON_DIR VERSO_BUNDLED_SITE_PACKAGES_DIR \
      VERSO_BUNDLED_DEFAULTS VERSO_BUNDLE_VERSION VERSO_PYTHON_CACHE_DIR \
      VERSO_BACKEND_URL VERSO_FRONTEND_URL VERSO_HERMES_HOME \
      VERSO_MEMORY_DB_PATH VERSO_SKIP_MANAGED_SESSION_KEYCHAIN \
      VERSO_HERMES_GATEWAY_URL VERSO_HERMES_COMMAND VERSO_HERMES_ARGS \
      VERSO_HERMES_CWD VERSO_HERMES_STARTUP_TIMEOUT_MS \
      VERSO_HERMES_API_SERVER_KEY VERSO_HERMES_MANAGED \
      VERSO_SIDECAR_AUTH_SECRET VERSO_PARENT_PID ORCHESTRATOR_PATH \
      VERSO_MANAGED_SESSION_TOKEN VERSO_MANAGED_SESSION_EXPIRES_AT \
      VERSO_MANAGED_USER_ID VERSO_RUNTIME_MODE \
      VERSO_BROWSER_DATA_ROOT VERSO_BROWSER_SETTINGS_PATH \
      VERSO_COMPOSIO_TOOL_USAGE_STORE_PATH VERSO_CUSTOM_CONNECTOR_ICONS_DIR \
      VERSO_CUSTOM_CONNECTORS_STORE_PATH VERSO_INGESTION_STORE_PATH

export VERSO_RUNTIME_MODE="${VERSO_RUN_PROFILE}"
if [ "${VERSO_RUN_PROFILE}" = "managed" ]; then
    # Product development uses the deployed services, which own the Privy
    # configuration and managed session API.
    export VERSO_FRONTEND_URL="https://www.itsverso.xyz/login"
    export VERSO_BACKEND_URL="https://verso-backend-2lg3.onrender.com"
else
    # Community/BYO runs must remain inert even if launchd inherited a stale
    # production URL from a previous managed debugging session.
    export VERSO_BACKEND_URL="off"
fi

# Keep a durable Conductor-specific profile and the shared memory corpus. Do
# not reuse the primary app profile here: it can intentionally hold a
# different provider configuration (for example Codex) and a Debug run must
# not silently replace a working Anthropic configuration with it. This profile
# survives rebuilds and is shared by this repository's nonconcurrent
# workspaces, while staying isolated from the installed app's account state.
if [ "${VERSO_RUN_PROFILE}" = "managed" ]; then
    CONDUCTOR_HERMES_HOME="${HOME}/Library/Application Support/Verso/conductor-hermes-home"
else
    CONDUCTOR_HERMES_HOME="${HOME}/Library/Application Support/Verso/conductor-${VERSO_RUN_PROFILE}-hermes-home"
fi
LEGACY_WORKSPACE_HERMES_HOME="${WORKSPACE_PATH}/.hermes-dev-home"
if [ "${VERSO_RUN_PROFILE}" = "managed" ] \
    && [ ! -f "${CONDUCTOR_HERMES_HOME}/config.yaml" ] \
    && [ -f "${LEGACY_WORKSPACE_HERMES_HOME}/config.yaml" ]; then
    echo "[conductor-run] migrating existing workspace Hermes profile"
    mkdir -p "${CONDUCTOR_HERMES_HOME}"
    rsync -a "${LEGACY_WORKSPACE_HERMES_HOME}/" "${CONDUCTOR_HERMES_HOME}/"
fi

# The installed app can hold long-lived Codex credentials, scheduled jobs,
# and the expanded connected-tool manifest while the previous workspace
# profile holds the known-good Claude configuration. Merge those additive
# capabilities once without copying the installed app's config.yaml (which
# could overwrite this profile's selected provider and endpoint).
PRIMARY_HERMES_HOME="${HOME}/Library/Application Support/Verso/hermes-home"
PROFILE_MIGRATION_MARKER="${CONDUCTOR_HERMES_HOME}/.conductor-capabilities-v1"
if [ "${VERSO_RUN_PROFILE}" = "managed" ] \
    && [ ! -f "${PROFILE_MIGRATION_MARKER}" ] \
    && [ -d "${PRIMARY_HERMES_HOME}" ]; then
    echo "[conductor-run] restoring installed-app capabilities in Conductor profile"
    CONDUCTOR_HERMES_HOME="${CONDUCTOR_HERMES_HOME}" \
        PRIMARY_HERMES_HOME="${PRIMARY_HERMES_HOME}" node <<'NODE'
const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const targetPath = join(process.env.CONDUCTOR_HERMES_HOME, 'auth.json');
const sourcePath = join(process.env.PRIMARY_HERMES_HOME, 'auth.json');
if (existsSync(sourcePath)) {
  let target = {};
  let source = {};
  try { target = JSON.parse(readFileSync(targetPath, 'utf8')); } catch {}
  try { source = JSON.parse(readFileSync(sourcePath, 'utf8')); } catch {}
  const sourcePool = source?.credential_pool?.['openai-codex'];
  const targetPool = target?.credential_pool?.['openai-codex'];
  if (Array.isArray(sourcePool) && sourcePool.length > 0
      && (!Array.isArray(targetPool) || targetPool.length === 0)) {
    target.credential_pool = { ...(target.credential_pool || {}), 'openai-codex': sourcePool };
    writeFileSync(`${targetPath}.tmp`, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
    renameSync(`${targetPath}.tmp`, targetPath);
  }
}
NODE
    if [ -d "${PRIMARY_HERMES_HOME}/cron" ] \
        && [ ! -e "${CONDUCTOR_HERMES_HOME}/cron/jobs.json" ]; then
        rsync -a "${PRIMARY_HERMES_HOME}/cron/" "${CONDUCTOR_HERMES_HOME}/cron/"
    fi
    if [ -f "${PRIMARY_HERMES_HOME}/verso-composio-tools.json" ] \
        && { [ ! -f "${CONDUCTOR_HERMES_HOME}/verso-composio-tools.json" ] \
            || [ "${PRIMARY_HERMES_HOME}/verso-composio-tools.json" -nt "${CONDUCTOR_HERMES_HOME}/verso-composio-tools.json" ]; }; then
        rsync -a "${PRIMARY_HERMES_HOME}/verso-composio-tools.json" "${CONDUCTOR_HERMES_HOME}/"
    fi
    touch "${PROFILE_MIGRATION_MARKER}"
fi
export VERSO_HERMES_HOME="${CONDUCTOR_HERMES_HOME}"
if [ "${VERSO_RUN_PROFILE}" = "managed" ]; then
    export VERSO_MEMORY_DB_PATH="${HOME}/Library/Application Support/Verso/memory/verso-memory.db"
else
    export VERSO_MEMORY_DB_PATH="${HOME}/Library/Application Support/Verso/runtime/${VERSO_RUN_PROFILE}/memory/verso-memory.db"
fi
echo "[conductor-run] profile=${VERSO_RUN_PROFILE} hermes=${VERSO_HERMES_HOME}"

if [ ! -d "${DEVELOPER_DIR}" ]; then
    echo "[conductor-run] ERROR: Xcode not found at ${DEVELOPER_DIR}" >&2
    exit 1
fi

if pgrep -x "verso" >/dev/null 2>&1; then
    cat >&2 <<'EOF'
[conductor-run] ERROR: a Verso app process is already running.

Quit the current app before starting this Conductor run. Verso/Hermes currently
share user account and Hermes state, and this run script intentionally refuses
to launch a second instance against that state.
EOF
    exit 1
fi

"${WORKSPACE_PATH}/scripts/conductor/setup.sh"

xcodebuild \
    -project "${WORKSPACE_PATH}/verso.xcodeproj" \
    -scheme "verso" \
    -configuration "Debug" \
    -derivedDataPath "${WORKSPACE_PATH}/DerivedData" \
    build

app_path="$(
    xcodebuild \
        -project "${WORKSPACE_PATH}/verso.xcodeproj" \
        -scheme "verso" \
        -configuration "Debug" \
        -derivedDataPath "${WORKSPACE_PATH}/DerivedData" \
        -showBuildSettings \
        2>/dev/null \
        | awk -F ' = ' '
            $1 ~ /^[[:space:]]*TARGET_BUILD_DIR$/ { target=$2 }
            $1 ~ /^[[:space:]]*WRAPPER_NAME$/ { wrapper=$2 }
            END {
                if (target != "" && wrapper != "") {
                    print target "/" wrapper
                }
            }
        '
)"

binary_path="${app_path}/Contents/MacOS/verso"
if [ ! -x "${binary_path}" ]; then
    echo "[conductor-run] ERROR: built app binary not found at ${binary_path}" >&2
    exit 1
fi

echo "[conductor-run] launching ${binary_path}"
exec "${binary_path}"
