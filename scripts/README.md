# Repository scripts

Scripts are grouped by who invokes them. Run commands from the repository root.

| Directory | Owner | Purpose |
|---|---|---|
| `build/` | Xcode, CI, developers | Build the WebView and bundled runtime, apply Hermes patches, copy and sign app resources |
| `ci/` | GitHub Actions | Fast repository, licensing, style, and runtime-profile guards |
| `conductor/` | Conductor | Prepare and run a workspace using the root workspace's shared runtime bundle |
| `qa/` | Developers | Boot-smoke the Hermes bundle and launch an isolated release candidate |
| `release/` | Release operator | Build, notarize, package, and generate the Sparkle appcast |
| `admin/` | Operators | Explicit incident-response utilities; these are not part of a build |
| `lib/` | Other scripts and CI | Shared runtime configuration, release paths, and smoke assertions |

There are deliberately no scripts at the root of this directory. A new script
should go in the group matching its caller; one-time asset migrations do not
belong here.

## Release paths

Every release step sources `lib/release-paths.sh` and therefore operates on the
same app:

```text
DerivedData-release/Build/Products/Release/verso.app
```

This avoids accidentally packaging an older app from Xcode's global
`DerivedData`. Advanced callers can override `VERSO_RELEASE_DERIVED_DATA`,
`VERSO_RELEASE_APP`, or `VERSO_RELEASE_DIST`.

## Per-release flow

```bash
# 1. Build the pinned Node/Python/Hermes runtime and run its gateway smoke test.
./scripts/build/build-runtime-bundles.sh

# 2. Build and verify the managed Release app in DerivedData-release/.
./scripts/release/build-managed.sh

# 3. Test the app with isolated preferences, session, Hermes, and local state.
./scripts/qa/fresh-install.sh start
# ...exercise sign-in, chat, memory, connections, and updates...
./scripts/qa/fresh-install.sh stop

# 4. Notarize and staple that same app.
./scripts/release/notarize-app.sh

# 5. Create, sign, notarize, and staple the DMG.
./scripts/release/make-dmg.sh

# 6. Generate dist/appcast.xml. This does not publish the release.
./scripts/release/generate-appcast.sh
```

`make-dmg.sh` refuses to package an app unless the Hermes bytes embedded in it
match a passing smoke marker. The isolated QA command does not move or delete
the developer's normal Verso or Hermes data.

After appcast generation, create the matching GitHub release, upload the DMG,
copy `dist/appcast.xml` to `frontend/public/appcast.xml`, and deploy the
frontend.

## One-time release-machine setup

Install the `Developer ID Application: Hugo Sanchez (2T2JL5F698)` certificate
and `create-dmg`, then store Apple notarization credentials under the `Verso`
profile:

```bash
brew install create-dmg
xcrun notarytool store-credentials "Verso" \
  --apple-id you@example.com \
  --team-id 2T2JL5F698 \
  --password <app-specific-password>
```

`generate-appcast.sh` also expects the Sparkle EdDSA key in
`/tmp/verso-edkey.txt` by default and securely removes that temporary file on
exit. See the script header for overrides.
