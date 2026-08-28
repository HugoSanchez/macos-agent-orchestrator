#!/usr/bin/env bash
# Apply the exact, ordered Verso patch set to a Hermes source or site-packages
# tree. Keeping this in one place makes CI exercise the release build contract.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=../lib/runtime-config.sh
source "${REPO_ROOT}/scripts/lib/runtime-config.sh"

patch_dir="${REPO_ROOT}/desktop/runtime-patches/hermes-agent"
listed_patch_names="$({
    printf '%s\n' "${HERMES_PATCHES[@]}"
    printf '%s\n' "${HERMES_SOURCE_TEST_PATCHES[@]}"
} | LC_ALL=C sort)"
actual_patch_names="$(find "${patch_dir}" -maxdepth 1 -type f -name '*.patch' -exec basename {} \; | LC_ALL=C sort)"
if [ "${listed_patch_names}" != "${actual_patch_names}" ]; then
    echo "[hermes-patches] ERROR: runtime-config.sh patch inventory does not match ${patch_dir}" >&2
    diff -u <(printf '%s\n' "${listed_patch_names}") <(printf '%s\n' "${actual_patch_names}") >&2 || true
    exit 1
fi

target_root="${1:-}"
if [ "${target_root}" = "--check" ]; then
    total_patch_count=$(( ${#HERMES_PATCHES[@]} + ${#HERMES_SOURCE_TEST_PATCHES[@]} ))
    echo "[hermes-patches] inventory verified (${total_patch_count} patches)"
    exit 0
fi
if [ -z "${target_root}" ] || [ ! -d "${target_root}" ]; then
    echo "usage: $0 <hermes-source-or-site-packages-directory> | --check" >&2
    exit 2
fi

for patch_name in "${HERMES_PATCHES[@]}"; do
    patch_file="${patch_dir}/${patch_name}"
    echo "[hermes-patches] applying ${patch_name}"
    patch -d "${target_root}" -p1 --batch < "${patch_file}"
done

if [ -d "${target_root}/tests" ]; then
    for patch_name in "${HERMES_SOURCE_TEST_PATCHES[@]}"; do
        patch_file="${patch_dir}/${patch_name}"
        echo "[hermes-patches] applying source tests ${patch_name}"
        patch -d "${target_root}" -p1 --batch < "${patch_file}"
    done
else
    echo "[hermes-patches] source tests absent; skipping ${#HERMES_SOURCE_TEST_PATCHES[@]} test-only patch(es)"
fi
