#!/usr/bin/env bash
# Reject release candidates that still expose the retired Privy/custom-scheme
# login flow. Run this after building and again immediately before packaging so
# a stale DerivedData product cannot silently become a release artifact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/release-paths.sh
source "${SCRIPT_DIR}/../lib/release-paths.sh"

APP_PATH="${1:-${VERSO_RELEASE_APP}}"
INFO_PLIST="${APP_PATH}/Contents/Info.plist"

if [ ! -f "${INFO_PLIST}" ]; then
    echo "[auth-boundary] ERROR: Info.plist not found at ${INFO_PLIST}" >&2
    exit 1
fi

EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${INFO_PLIST}" 2>/dev/null || true)"
EXECUTABLE_PATH="${APP_PATH}/Contents/MacOS/${EXECUTABLE_NAME}"
if [ -z "${EXECUTABLE_NAME}" ] || [ ! -f "${EXECUTABLE_PATH}" ]; then
    echo "[auth-boundary] ERROR: app executable not found at ${EXECUTABLE_PATH}" >&2
    exit 1
fi

if /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "${INFO_PLIST}" >/dev/null 2>&1; then
    if ! python3 - "${INFO_PLIST}" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    plist = plistlib.load(handle)

retired = {"verso", "verso-dev"}
configured = {
    str(scheme).strip().lower()
    for entry in plist.get("CFBundleURLTypes", [])
    if isinstance(entry, dict)
    for scheme in entry.get("CFBundleURLSchemes", [])
}
blocked = sorted(configured & retired)
if blocked:
    print(
        "[auth-boundary] ERROR: retired auth URL scheme(s) present: "
        + ", ".join(blocked),
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
    then
        exit 1
    fi
fi

if ! python3 - "${APP_PATH}" <<'PY'
import os
import sys

app_path = sys.argv[1]
markers = (
    b"verso://auth/callback",
    b"fresh_privy_session",
    b"privyUserId",
    b"/v1/auth/privy/exchange",
)
chunk_size = 1024 * 1024
overlap_size = max(map(len, markers)) - 1

for root, _, filenames in os.walk(app_path):
    for filename in filenames:
        path = os.path.join(root, filename)
        if os.path.islink(path):
            continue
        try:
            with open(path, "rb") as handle:
                overlap = b""
                while chunk := handle.read(chunk_size):
                    searchable = overlap + chunk
                    for marker in markers:
                        if marker in searchable:
                            relative_path = os.path.relpath(path, app_path)
                            print(
                                "[auth-boundary] ERROR: retired auth marker "
                                f"{marker.decode()} found in {relative_path}",
                                file=sys.stderr,
                            )
                            raise SystemExit(1)
                    overlap = searchable[-overlap_size:]
        except OSError as error:
            print(
                f"[auth-boundary] ERROR: could not inspect {path}: {error}",
                file=sys.stderr,
            )
            raise SystemExit(1)
PY
then
    exit 1
fi

echo "[auth-boundary] OK: no retired Privy callback surface in ${APP_PATH}"
