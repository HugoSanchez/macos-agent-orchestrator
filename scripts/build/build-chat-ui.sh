#!/usr/bin/env bash
# Build the React WebView and publish the exact output embedded by the app.
# Xcode and CI share this path so checked-in assets cannot drift from source.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHAT_UI_DIR="${REPO_ROOT}/desktop/chat-ui"
EMBEDDED_DIR="${REPO_ROOT}/desktop/macos/chat-ui"

export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH}"
cd "${CHAT_UI_DIR}"
if [ ! -d node_modules ]; then
    npm ci
fi
npm run build

# The target is a fixed repository subdirectory, never caller-controlled.
rm -rf "${EMBEDDED_DIR}"
cp -R "${CHAT_UI_DIR}/dist" "${EMBEDDED_DIR}"
