#!/usr/bin/env bash
# Keep the public download button aligned with the newest Sparkle release.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

LANDING_PAGE="frontend/src/app/landing-page/page.tsx"
APPCAST="frontend/public/appcast.xml"

appcast_version="$({
    sed -n 's|.*<sparkle:shortVersionString>\([^<]*\)</sparkle:shortVersionString>.*|\1|p' "${APPCAST}"
} | head -n 1)"

download_versions="$({
    sed -n 's|.*releases/download/v\([^/]*\)/verso-\([^/]*\)\.dmg.*|\1 \2|p' "${LANDING_PAGE}"
} | sort -u)"

if [ -z "${appcast_version}" ]; then
    echo "release-download: could not read the newest version from ${APPCAST}" >&2
    exit 1
fi

expected_versions="${appcast_version} ${appcast_version}"
if [ "${download_versions}" != "${expected_versions}" ]; then
    echo "release-download: landing page does not download the newest Sparkle release" >&2
    echo "release-download: expected tag and filename versions: ${expected_versions}" >&2
    echo "release-download: found: ${download_versions:-missing}" >&2
    exit 1
fi

echo "release-download: passed (${appcast_version})"
