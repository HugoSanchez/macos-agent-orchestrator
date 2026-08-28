#!/usr/bin/env bash
#
# check-style-tokens.sh — color-literal guard for the Verso editorial redesign.
#
# The redesign funnels every color through semantic design tokens: CSS custom
# properties defined in ONE place (chat-ui/src/styles/tokens.css) and the Swift
# ConductorThemePalette / ConductorThemes region in NativeShellTheme.swift. This
# script fails CI if a raw color literal leaks in anywhere else, so the palette
# stays the single source of truth for both light and dark.
#
# It fails when:
#   1. a color literal (#hex, rgb(, rgba(, hsl() appears in
#      chat-ui/src/styles/*.css OUTSIDE tokens.css (fonts.css / @font-face exempt);
#   2. a color literal appears in a chat-ui/src/*.tsx inline style (SVG
#      presentation attributes — fill=/stroke=/stop-color — are inline vector
#      art, not theme surfaces, and are allowlisted);
#   3. a `Color(red:` / `Color.white.opacity(` / `Color.black.opacity(` literal
#      appears in the native shell OUTSIDE NativeShellTheme's palette region.
#      Allowlisted: the traffic-light classic fills (WindowControlButton(color:))
#      and AppKit `NSColor(red:` bridging. SignInView.swift and
#      UpdateToastUserDriver.swift are exempt files (documented mode-independent
#      surfaces) and are not scanned.
#
# Run locally:  bash scripts/ci/check-style-tokens.sh
set -uo pipefail

# Resolve repo root from this script's location so it runs from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CHAT_UI="desktop/chat-ui/src"
THEME_FILE="desktop/macos/NativeShellTheme.swift"
MACOS_SOURCES="desktop/macos"

# Guard against silently scanning nothing if these paths ever move.
[ -d "$CHAT_UI/styles" ] || { echo "style-guard: missing $CHAT_UI/styles" >&2; exit 1; }
[ -f "$THEME_FILE" ] || { echo "style-guard: missing $THEME_FILE" >&2; exit 1; }

# A color literal: #hex (3/4/6/8 digits), rgb(, rgba(, or hsl(/hsla(.
COLOR_RE='#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\('

fail=0
note() { printf '  %s\n' "$1"; }

# ---- 1. CSS outside tokens.css --------------------------------------------
echo "== CSS color literals outside tokens.css =="
css_hits=""
for f in "$CHAT_UI"/styles/*.css; do
  case "$(basename "$f")" in
    tokens.css|fonts.css) continue ;;  # single source of truth / @font-face
  esac
  hits="$(grep -nE "$COLOR_RE" "$f" || true)"
  if [ -n "$hits" ]; then
    css_hits="$css_hits"$'\n'"$(printf '%s' "$hits" | sed "s#^#$f:#")"
  fi
done
if [ -n "${css_hits// /}" ]; then
  fail=1
  note "FAIL — color literals must live in tokens.css:"
  printf '%s\n' "$css_hits" | sed '/^$/d' | sed 's/^/    /'
else
  note "ok"
fi

# ---- 2. TSX inline styles --------------------------------------------------
# Flag color literals in top-level *.tsx, excluding SVG presentation attributes
# (fill= / stroke= / stop-color / flood-color) which are inline vector art.
echo "== TSX inline-style color literals =="
tsx_hits="$(grep -rnE "$COLOR_RE" "$CHAT_UI"/*.tsx 2>/dev/null \
  | grep -vE '(fill|stroke|stop-color|stopColor|flood-color|floodColor)=' \
  || true)"
if [ -n "$tsx_hits" ]; then
  fail=1
  note "FAIL — color literals must come from CSS tokens, not inline styles:"
  printf '%s\n' "$tsx_hits" | sed 's/^/    /'
else
  note "ok"
fi

# ---- 3. Swift outside the palette region -----------------------------------
# The palette region spans the ConductorThemePalette struct through the end of
# the ConductorThemes enum (i.e. up to the next declaration, ConductorType).
echo "== Swift color literals outside the palette region ($THEME_FILE) =="
swift_hits=""
for swift_file in "$MACOS_SOURCES"/*.swift; do
  case "$(basename "$swift_file")" in
    SignInView.swift|UpdateToastUserDriver.swift) continue ;;
  esac
  hits="$(awk '
    /struct ConductorThemePalette \{/ { inpal=1 }
    /enum ConductorType \{/           { inpal=0 }
    {
      if (!inpal) {
        # traffic-light classic fills are exempt
        if ($0 ~ /WindowControlButton\(color: Color\(red:/) next
        # Color(red: but NOT NSColor(red: (AppKit bridging is out of scope)
        if ($0 ~ /(^|[^A-Za-z])Color\(red:/ || $0 ~ /Color\.white\.opacity\(/ || $0 ~ /Color\.black\.opacity\(/) {
          printf "    %s:%d: %s\n", FILENAME, NR, $0
        }
      }
    }
' "$swift_file")"
  if [ -n "$hits" ]; then
    swift_hits="$swift_hits"$'\n'"$hits"
  fi
done
if [ -n "$swift_hits" ]; then
  fail=1
  note "FAIL — theme colors must come from ConductorThemePalette / ConductorThemes:"
  printf '%s\n' "$swift_hits"
else
  note "ok"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "style-guard: FAILED — move the flagged colors into the design tokens / palette."
  exit 1
fi
echo "style-guard: passed — all colors flow through the design tokens / palette."
