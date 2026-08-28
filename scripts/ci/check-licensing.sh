#!/usr/bin/env bash
# Keep Verso's declared license and shipped third-party notices from drifting.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

fail() {
    echo "licensing: $1" >&2
    exit 1
}

grep -q '^                    GNU AFFERO GENERAL PUBLIC LICENSE$' LICENSE \
    || fail "LICENSE is not the GNU AGPL v3 text"
grep -q '^                       Version 3, 19 November 2007$' LICENSE \
    || fail "LICENSE is not GNU AGPL version 3"
grep -q 'AGPL-3.0-only' README.md \
    || fail "README does not declare AGPL-3.0-only"

package_files=(
    backend/package.json
    frontend/package.json
    desktop/orchestrator/package.json
    desktop/chat-ui/package.json
)
lock_files=(
    backend/package-lock.json
    frontend/package-lock.json
    desktop/orchestrator/package-lock.json
    desktop/chat-ui/package-lock.json
)

for package_file in "${package_files[@]}"; do
    node -e '
      const manifest = require("./" + process.argv[1]);
      if (manifest.license !== "AGPL-3.0-only") process.exit(1);
    ' "${package_file}" || fail "${package_file} does not declare AGPL-3.0-only"
done

for lock_file in "${lock_files[@]}"; do
    node -e '
      const lock = require("./" + process.argv[1]);
      if (lock.packages?.[""]?.license !== "AGPL-3.0-only") process.exit(1);
    ' "${lock_file}" || fail "${lock_file} root package does not declare AGPL-3.0-only"
done

notice_files=(
    THIRD_PARTY_NOTICES.md
    LICENSES/Hermes-Agent-MIT.txt
    LICENSES/IBM-Plex-OFL-1.1.txt
    LICENSES/JetBrains-Mono-OFL-1.1.txt
    LICENSES/Python-3.11.txt
    LICENSES/Sentry-Cocoa-MIT.txt
    LICENSES/Sparkle.txt
)

for notice_file in "${notice_files[@]}"; do
    [ -s "${notice_file}" ] || fail "missing third-party notice: ${notice_file}"
done

grep -q 'LEGAL_DST=' scripts/build/copy-runtime-bundles.sh \
    || fail "app build does not configure a legal-notices destination"
grep -q 'Verso-AGPL-3.0-only.txt' scripts/build/copy-runtime-bundles.sh \
    || fail "app build does not copy the Verso license"
grep -q 'node/LICENSE' scripts/build/copy-runtime-bundles.sh \
    || fail "Release bundle does not require the Node.js license"

echo "licensing: passed"
