#!/usr/bin/env bash
# Prevent generated artifacts, local secrets, and oversized blobs from entering
# the repository. Historical cleanup is expensive; rejecting these at review
# time keeps the public Git history small and safe.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

MAX_TRACKED_BYTES=$((5 * 1024 * 1024))
fail=0

report_failure() {
  printf 'repository-hygiene: %s\n' "$1" >&2
  fail=1
}

is_generated_path() {
  local path="/$1/"
  case "$path" in
    */.next/*|*/node_modules/*|*/dist/*|*/build/*|*/DerivedData*/*|*/.supermemory/*|*/.hermes-dev-home/*|*/desktop/runtime-bundles/*)
      return 0
      ;;
  esac
  return 1
}

is_sensitive_path() {
  local path="$1"
  local basename="${path##*/}"
  local lowercase_path
  lowercase_path="$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"

  case "$basename" in
    .env|.env.local|.env.*.local|auth-secret|credentials.json)
      return 0
      ;;
  esac

  case "$lowercase_path" in
    *.p12|*.pfx|*.pem|*.mobileprovision|*sparkle*private*key*)
      return 0
      ;;
  esac
  return 1
}

while IFS= read -r -d '' tracked_path; do
  if is_generated_path "$tracked_path"; then
    report_failure "generated path is tracked: $tracked_path"
  fi

  if is_sensitive_path "$tracked_path"; then
    report_failure "secret-shaped path is tracked: $tracked_path"
  fi

  blob_size="$(git cat-file -s "HEAD:$tracked_path")"
  if [ "$blob_size" -gt "$MAX_TRACKED_BYTES" ]; then
    report_failure "tracked file exceeds 5 MiB ($blob_size bytes): $tracked_path"
  fi
done < <(git ls-files -z)

if [ "$fail" -ne 0 ]; then
  echo "repository-hygiene: FAILED" >&2
  exit 1
fi

echo "repository-hygiene: passed"
