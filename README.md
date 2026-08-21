# verso

A native macOS app for chatting with a local Hermes agent through a desktop UI.

## Architecture

- **desktop/macos/** -- SwiftUI macOS shell that hosts the chat UI
- **desktop/orchestrator/** -- local Node sidecar for Hermes sessions, streaming, persistence, and future tool integration
- **desktop/chat-ui/** -- bundled web chat frontend rendered inside the app
- **backend/** -- hosted API for managed users
- **frontend/** -- hosted web/auth frontend

## Development

```sh
# Open the macOS app in Xcode
open verso.xcodeproj

# Run the local sidecar for browser-only development.
# The macOS app supplies a per-launch token automatically; this opt-in is only
# for direct localhost browser testing.
cd desktop/orchestrator && npm install && VERSO_ALLOW_UNAUTHENTICATED_SIDECAR=1 npm run dev
```

### Managed Hermes startup

For local app testing, the clean path is:

- the app starts `orchestrator`
- `orchestrator` starts Hermes if needed

If Hermes was installed via the normal CLI flow, `orchestrator` will now auto-detect it and start:

```sh
hermes gateway run
```

`orchestrator` launches Hermes in an isolated verso profile under `~/.hermes/profiles/verso`, seeded from your default Hermes config on first run. That avoids clashing with any other Hermes gateway you may already have running.

No extra Xcode env vars are required for the common case.

Optional Xcode scheme environment overrides:

```sh
# Explicit CLI entrypoint instead of auto-detect
VERSO_HERMES_COMMAND="/absolute/path/to/hermes"
VERSO_HERMES_ARGS='["gateway","run"]'

# Launch working directory if needed
VERSO_HERMES_CWD="/absolute/path/to/hermes/repo"

# Override the isolated Hermes profile/home
VERSO_HERMES_HOME="/absolute/path/to/hermes-home"

# Pin the Hermes API server URL instead of letting orchestrator choose a free local port
VERSO_HERMES_GATEWAY_URL="http://127.0.0.1:8642"

# Startup timeout
VERSO_HERMES_STARTUP_TIMEOUT_MS="45000"
```

## Conductor

This repository has shared Conductor settings in `.conductor/settings.toml`.
Conductor runs setup and run scripts from each workspace, and this project is
configured for workspace-local builds. The shared settings set
`scripts.run_mode = "nonconcurrent"` because Verso still uses shared per-user
app/Hermes state. Conductor reflects shared repository settings only after they
are merged to the default branch on the remote (`origin/main`), not merely
because they exist on a workspace branch.

The default Conductor run script:

- validates `desktop/runtime-bundles/` from `CONDUCTOR_ROOT_PATH`
- links a workspace's `desktop/runtime-bundles` to that root-local bundle when
  needed, instead of copying the 1.1GB generated directory
- installs workspace-local `desktop/orchestrator` and `desktop/chat-ui`
  dependencies with `npm ci --no-audit --no-fund` when `package.json`,
  `package-lock.json`, Node, or npm change
- builds with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
- runs the built Debug app binary in the foreground so Conductor Stop controls
  the launched process
- refuses to start if another `verso` process is already running
- scrubs stale `VERSO_*` debugging overrides, then uses the deployed Privy
  frontend/backend and a durable Conductor Hermes profile. On its first run it
  migrates the existing workspace profile and restores the installed app's
  additive capabilities (Codex credentials, scheduled jobs, and connected
  tool manifest), without mixing in its conflicting model configuration.
  Indexed memory remains in the shared Verso memory DB, so it is available to
  the agent after every rebuild.

The runtime symlink keeps workspace execution clean without Spotlight testing:
the workspace builds and runs its own checked-out code, while the generated,
gitignored runtime bundle is reused from the repository root after validation.
The symlink points only at the validated root bundle and setup refuses any
mismatched existing runtime path. Nonconcurrent run mode remains necessary
because the product-like Conductor run deliberately uses shared per-user
account and memory state plus one durable Conductor Hermes profile.

If setup reports a missing or stale runtime bundle, repair it from the repository
root:

```sh
./scripts/build-runtime-bundles.sh
```

To revalidate an existing bundle without rebuilding everything:

```sh
./scripts/smoke-test-hermes-bundle.sh
```

Manual validation for Conductor changes:

```sh
CONDUCTOR_ROOT_PATH="$(pwd)" \
CONDUCTOR_WORKSPACE_PATH="$(pwd)" \
  ./scripts/conductor-setup.sh

# Fresh-workspace dependency behavior can be tested in a throwaway worktree or
# temporary fixture; setup writes only node_modules/.conductor-npm-ci.stamp when
# existing dependencies are already current.

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project verso.xcodeproj -scheme verso -configuration Debug \
  -derivedDataPath DerivedData build
```

## Repo

This repo is `huacamayo`. verso is the product.

## License

Copyright (C) 2026 Hugo Sanchez.

Verso is licensed under the [GNU Affero General Public License, version 3
only](LICENSE) (`AGPL-3.0-only`). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
