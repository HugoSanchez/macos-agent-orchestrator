# Release / signing scripts

Scripts that turn the working tree into a signed, notarized macOS `.app`
ready to drop into a DMG.

## One-time setup

Done once per machine, never automated.

### 1. Developer ID Application certificate

You need a `Developer ID Application: Hugo Sanchez (2T2JL5F698)` identity
in your login keychain.

- Apple Developer Portal → Certificates, Identifiers & Profiles → Certificates
  → "+" → **Developer ID Application** → follow the CSR flow.
- Double-click the downloaded `.cer` to install it.
- Confirm with: `security find-identity -p codesigning -v | grep "Developer ID"`

### 2. Notarytool credentials

Apple requires app-specific passwords for `notarytool`, not your iCloud
password.

1. Go to https://appleid.apple.com → Sign-In and Security →
   App-Specific Passwords → **Generate Password**. Label it
   `Verso notarytool` (the label is local; Apple sees only the password).
2. Store it in the keychain under the profile name `Verso`:

   ```bash
   xcrun notarytool store-credentials "Verso" \
       --apple-id   you@example.com \
       --team-id    2T2JL5F698 \
       --password   <the-app-specific-password>
   ```

   Verify with `xcrun notarytool history --keychain-profile Verso`.

## Per-release flow

```bash
# 1) Rebuild the runtime bundle if Node/Python/Hermes/deps changed.
#    Ends with the Hermes smoke gate: boots the bundle and requires a
#    streaming /v1/responses to answer 200 + SSE (catches mis-applied
#    runtime patches that survive "applies cleanly + byte-compiles" — see
#    the 1.0.15 every-chat-500s incident). A pass writes a .smoke-pass
#    marker that make-dmg.sh checks; there is no shipping around a failed
#    or skipped smoke test. Re-run standalone any time:
#    ./scripts/smoke-test-hermes-bundle.sh
./scripts/build-runtime-bundles.sh

# 2) Build the signed managed Release .app. Ordinary Release builds default
#    to local mode; this wrapper embeds and verifies the product profile.
./scripts/build-managed-release.sh

# 3) Notarize + staple.
./scripts/notarize-app.sh

# 4) Package and notarize the DMG. This refuses to package an app whose
#    embedded Hermes runtime did not pass the matching smoke test.
./scripts/make-dmg.sh

# 5) Generate the signed Sparkle appcast, then upload the DMG to GitHub and
#    deploy frontend/public/appcast.xml as described by the script.
./scripts/publish-release.sh
```

The Release build automatically:

- Copies bundled Node/Python/orchestrator/wheels/defaults into the .app
  (`Bundle Runtime Components` phase).
- Signs every embedded Mach-O with Developer ID + hardened runtime +
  entitlements (`Sign Embedded Binaries` phase).
- Signs the outer .app with the same identity (Xcode's built-in step).

The notarize script then ditto-zips the .app, submits to Apple, waits for
acceptance, and staples the ticket. The stapled .app passes Gatekeeper
even offline.

## Script reference

| Script | When it runs | What it does |
|---|---|---|
| `build-runtime-bundles.sh` | Manually, after deps or pins change | Populates `desktop/runtime-bundles/` with universal Node, both-arch Python, Hermes snapshot, pre-downloaded wheels, default configs |
| `smoke-test-hermes-bundle.sh` | Automatically at the end of every bundle build (or manually) | Boots the bundled gateway with a throwaway home, asserts a streaming `/v1/responses` returns 200 + SSE (no model creds needed), records a `.smoke-pass` marker keyed to the bundle stamp |
| `copy-runtime-bundles.sh` | Xcode Run Script phase (Release only) | `rsync desktop/runtime-bundles/* verso.app/Contents/Resources/` |
| `sign-bundle-binaries.sh` | Xcode Run Script phase (Release only) | Signs every Mach-O under `Resources/` with Developer ID + hardened runtime |
| `build-managed-release.sh` | Manually for an official release | Builds Release with `managed` embedded and verifies all managed service/update identifiers |
| `notarize-app.sh` | Manually, after Release build | Ditto-zips → submits to Apple → staples ticket |

CI (`.github/workflows/ci.yml`) runs on every PR: the orchestrator vitest
suite on macOS, plus a Linux job that installs Hermes at the pinned ref with
all runtime patches applied and runs the same boot-and-stream smoke check —
so a mis-anchored patch fails at PR time, months before it can reach a
release build.

## Smoke-testing the signed bundle

```bash
# Spawn the bundled orchestrator with a fake HOME and hermetic PATH so the
# friend's-Mac experience is reproducible.
RELEASE_APP=~/Library/Developer/Xcode/DerivedData/verso-*/Build/Products/Release/verso.app
RESOURCES="$RELEASE_APP/Contents/Resources"
WORK=$(mktemp -d)

HOME="$WORK/home" PATH="/usr/bin:/bin" \
  VERSO_RUNTIME_MODE=managed \
  VERSO_BUNDLED_PYTHON_DIR="$RESOURCES/python" \
  VERSO_BUNDLED_SITE_PACKAGES_DIR="$RESOURCES/site-packages" \
  VERSO_BUNDLED_DEFAULTS="$RESOURCES/hermes-defaults" \
  VERSO_HERMES_HOME="$WORK/home/Library/Application Support/Verso/hermes-home" \
  VERSO_BUNDLE_VERSION="$(cat "$RESOURCES/BUNDLE_VERSION")" \
  VERSO_BACKEND_URL=https://verso-backend-2lg3.onrender.com \
  "$RESOURCES/node/bin/node" \
  "$RESOURCES/orchestrator/node_modules/.bin/tsx" \
  "$RESOURCES/orchestrator/src/http/server.ts"
```

Hit `http://127.0.0.1:<port>/diagnostics` and confirm `hermes.state == "ready"`.
