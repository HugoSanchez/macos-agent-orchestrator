#!/usr/bin/env bash
#
# Prepare a Conductor workspace for Verso without copying the root-local
# runtime bundle. Conductor may run this from a worktree, while the generated
# desktop/runtime-bundles directory is intentionally gitignored and large.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runtime-config.sh
source "${SCRIPT_DIR}/runtime-config.sh"

WORKSPACE_PATH="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"
ROOT_PATH="${CONDUCTOR_ROOT_PATH:-${WORKSPACE_PATH}}"
ROOT_BUNDLE="${ROOT_PATH}/desktop/runtime-bundles"
WORKSPACE_BUNDLE="${WORKSPACE_PATH}/desktop/runtime-bundles"
BUNDLED_NODE_BIN="${ROOT_BUNDLE}/node/bin"

required_paths=(
    "${ROOT_BUNDLE}/BUNDLE_VERSION"
    "${ROOT_BUNDLE}/node/bin/node"
    "${ROOT_BUNDLE}/orchestrator/node_modules"
    "${ROOT_BUNDLE}/python/arm64/python/bin/python3.11"
    "${ROOT_BUNDLE}/site-packages/arm64/site-packages"
    "${ROOT_BUNDLE}/site-packages/arm64/bin/hermes"
    "${ROOT_BUNDLE}/site-packages/arm64/.stamp"
    "${ROOT_BUNDLE}/site-packages/arm64/.smoke-pass"
    "${ROOT_BUNDLE}/hermes-defaults/config.yaml"
    "${ROOT_BUNDLE}/hermes-defaults/skills"
    "${ROOT_BUNDLE}/hermes-defaults/optional-skills"
)

for path in "${required_paths[@]}"; do
    if [ ! -e "${path}" ]; then
        cat >&2 <<EOF
[conductor-setup] ERROR: root runtime bundle is missing or incomplete:
  ${path}

Repair from the repository root:
  ./scripts/build-runtime-bundles.sh

This project keeps desktop/runtime-bundles gitignored because it is large.
Conductor workspaces reuse the validated root-local bundle instead of copying it.
EOF
        exit 1
    fi
done

runtime_patch_dir="${WORKSPACE_PATH}/desktop/runtime-patches/hermes-agent"
expected_runtime_patch_stamp="$(hermes_runtime_patch_stamp "${runtime_patch_dir}")"
expected_runtime_stamp="${HERMES_REF}|${HERMES_EXTRAS}|${HERMES_EXTRA_PINS[*]}|${PYTHON_VERSION}|patches:${expected_runtime_patch_stamp}"
actual_runtime_stamp="$(cat "${ROOT_BUNDLE}/site-packages/arm64/.stamp")"
if [ "${actual_runtime_stamp}" != "${expected_runtime_stamp}" ]; then
    cat >&2 <<EOF
[conductor-setup] ERROR: shared Hermes runtime is stale for this workspace.

Rebuild from this workspace, then run Verso again:
  ./scripts/build-runtime-bundles.sh
EOF
    exit 1
fi

if ! cmp -s "${ROOT_BUNDLE}/site-packages/arm64/.stamp" "${ROOT_BUNDLE}/site-packages/arm64/.smoke-pass"; then
    cat >&2 <<EOF
[conductor-setup] ERROR: runtime bundle smoke marker does not match its stamp.

Repair from the repository root:
  ./scripts/smoke-test-hermes-bundle.sh

If the bundle was intentionally rebuilt, run:
  ./scripts/build-runtime-bundles.sh
EOF
    exit 1
fi

if [ "${WORKSPACE_PATH}" != "${ROOT_PATH}" ]; then
    mkdir -p "$(dirname "${WORKSPACE_BUNDLE}")"
    if [ -L "${WORKSPACE_BUNDLE}" ]; then
        linked_target="$(readlink "${WORKSPACE_BUNDLE}")"
        if [ "${linked_target}" != "${ROOT_BUNDLE}" ]; then
            echo "[conductor-setup] ERROR: ${WORKSPACE_BUNDLE} points to ${linked_target}, expected ${ROOT_BUNDLE}" >&2
            exit 1
        fi
    elif [ -e "${WORKSPACE_BUNDLE}" ]; then
        # A workspace created before the shared-root cache convention may
        # already contain a generated (and gitignored) runtime bundle. It is
        # safe to replace only that recognizable cache with the managed
        # symlink: all source-controlled runtime inputs live elsewhere and
        # the validated root cache is the canonical replacement. Refuse any
        # other directory so setup never deletes user-owned local data.
        if [ -f "${WORKSPACE_BUNDLE}/BUNDLE_VERSION" ] \
            && [ -d "${WORKSPACE_BUNDLE}/node" ] \
            && [ -d "${WORKSPACE_BUNDLE}/site-packages" ]; then
            echo "[conductor-setup] migrating generated workspace runtime bundle to root cache"
            rm -rf "${WORKSPACE_BUNDLE}"
            ln -s "${ROOT_BUNDLE}" "${WORKSPACE_BUNDLE}"
        else
            echo "[conductor-setup] ERROR: ${WORKSPACE_BUNDLE} exists and is not the managed symlink." >&2
            echo "Refusing to replace an unrecognized local directory; inspect it manually." >&2
            exit 1
        fi
    else
        ln -s "${ROOT_BUNDLE}" "${WORKSPACE_BUNDLE}"
        echo "[conductor-setup] linked workspace runtime bundle -> ${ROOT_BUNDLE}"
    fi
fi

export PATH="${BUNDLED_NODE_BIN}:${PATH}"

if ! command -v npm >/dev/null 2>&1; then
    echo "[conductor-setup] ERROR: npm is required to install workspace dependencies but was not found on PATH." >&2
    exit 1
fi

install_npm_deps_if_needed() {
    local package_dir="$1"
    local package_name="$2"
    local required_bin="$3"
    local package_json="${package_dir}/package.json"
    local package_lock="${package_dir}/package-lock.json"
    local node_modules="${package_dir}/node_modules"
    local required_bin_path="${node_modules}/.bin/${required_bin}"
    local marker="${node_modules}/.conductor-npm-ci.stamp"

    if [ ! -f "${package_json}" ] || [ ! -f "${package_lock}" ]; then
        echo "[conductor-setup] ERROR: ${package_name} package files are missing in ${package_dir}" >&2
        exit 1
    fi

    local expected
    expected="$(
        {
            shasum -a 256 "${package_json}"
            shasum -a 256 "${package_lock}"
            node --version
            npm --version
        } | shasum -a 256 | awk '{print $1}'
    )"

    if [ -d "${node_modules}" ] && [ -x "${required_bin_path}" ] && [ -f "${marker}" ] && [ "$(cat "${marker}")" = "${expected}" ]; then
        echo "[conductor-setup] ${package_name} dependencies already current"
        return
    fi

    echo "[conductor-setup] installing ${package_name} dependencies with npm ci"
    (
        cd "${package_dir}"
        npm ci --no-audit --no-fund
    )

    if [ ! -d "${node_modules}" ]; then
        echo "[conductor-setup] ERROR: npm ci did not create ${node_modules}" >&2
        exit 1
    fi
    if [ ! -x "${required_bin_path}" ]; then
        echo "[conductor-setup] ERROR: expected ${required_bin_path} after npm ci" >&2
        exit 1
    fi
    echo "${expected}" > "${marker}"
}

install_npm_deps_if_needed "${WORKSPACE_PATH}/desktop/orchestrator" "desktop/orchestrator" "tsx"
install_npm_deps_if_needed "${WORKSPACE_PATH}/desktop/chat-ui" "desktop/chat-ui" "vite"

echo "[conductor-setup] runtime bundle ready: $(cat "${ROOT_BUNDLE}/BUNDLE_VERSION")"
