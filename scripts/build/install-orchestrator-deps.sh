#!/usr/bin/env bash
# Install a standalone runtime dependency tree, including local first-party
# packages. Preserve the repository layout only in a disposable staging area;
# npm install-links packs local packages instead of shipping dangling symlinks.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
destination="${1:?usage: install-orchestrator-deps.sh <orchestrator-bundle>}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/verso-dependencies.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/desktop/orchestrator" "$stage/packages"
cp "$REPO_ROOT/desktop/orchestrator/"{package.json,package-lock.json,.npmrc} "$stage/desktop/orchestrator/"
rsync -a --exclude node_modules "$REPO_ROOT/packages/composio/" "$stage/packages/composio/"
(cd "$stage/desktop/orchestrator" && npm ci --include=dev --no-audit --no-fund --loglevel=error)
mkdir -p "$destination/node_modules"
rsync -a --delete "$stage/desktop/orchestrator/node_modules/" "$destination/node_modules/"
