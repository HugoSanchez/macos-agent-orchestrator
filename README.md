# Verso

Verso is a native macOS agent orchestrator built with [Hermes Agent](https://github.com/NousResearch/hermes-agent). The SwiftUI shell, local Node sidecar, and embedded React chat interface live in this repository.

Source builds default to `local` mode. They do not require a Verso account and do not use Verso's hosted backend, Sentry project, or update feed. You bring your own model access through Codex OAuth or an Anthropic API key.

> [!IMPORTANT]
> This quickstart has been exercised in the existing development environment, but not yet followed from start to finish on a clean Mac. Clean-machine verification is a release blocker for the first public release; see the [acceptance checklist](#clean-machine-acceptance-checklist).

## What works in local mode

- Local chats and session history
- Codex models through OpenAI's device login
- Claude models through your own Anthropic API key
- Hermes tools, skills, routines, memory, and agent browser
- Custom MCP connectors

Verso-managed accounts, hosted Composio connections, managed ingestion sources, Sentry, and Sparkle updates are intentionally unavailable in local mode.

## Quickstart

### Requirements

- An Apple Silicon Mac running macOS 14 or newer
- A full Xcode installation at `/Applications/Xcode.app`
- Git
- Node.js 24 and npm; CI and the bundled runtime currently use Node 24
- A model provider: either an OpenAI account that can use Codex or an Anthropic API key

The release runtime is currently built for Apple Silicon. Intel source builds have not been validated yet.

Confirm the local toolchain:

```sh
xcodebuild -version
node --version
npm --version
git --version
```

If you use Homebrew, `brew install node` places Node where the native app can discover it. Verso currently checks `/opt/homebrew/bin/node`, `/usr/local/bin/node`, and `/usr/bin/node` when running an unbundled Debug build.

### 1. Clone the repository and install JavaScript dependencies

```sh
git clone https://github.com/HugoSanchez/huacamayo.git verso
cd verso

(cd desktop/orchestrator && npm ci)
(cd desktop/chat-ui && npm ci)
```

The backend and hosted frontend are not required for a local desktop build.

### 2. Install Hermes

Verso can start a Hermes CLI installed in your user account. The current upstream macOS installer is:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.zshrc
hermes --version
```

If you prefer to inspect installers before executing them, download the script first and review it locally. The upstream [Hermes documentation](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) also describes manual installation and setup.

Verso does not run Hermes against your ordinary `~/.hermes` state. Local launches use an isolated home under:

```text
~/Library/Application Support/Verso/runtime/local/hermes-home
```

The installed Hermes home is used only as a template when Verso initializes that isolated profile.

### 3. Build and run Verso

The simplest development loop is Xcode:

```sh
open verso.xcodeproj
```

Select the `verso` scheme and **My Mac**, then press **Cmd+R**. Debug and ordinary Release builds embed `local` as their default runtime mode; no scheme environment variables are required.

You can also build and launch from Terminal:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild \
    -project verso.xcodeproj \
    -scheme verso \
    -configuration Debug \
    -derivedDataPath DerivedData \
    build

open DerivedData/Build/Products/Debug/verso.app
```

The Xcode build phase compiles the React chat UI. The app then starts the Node sidecar, which starts Hermes on a local loopback port.

### 4. Connect a model provider

When the app opens:

1. Click **settings** in the lower-left corner.
2. Choose one provider:
   - **Codex:** click **Connect Codex**, open the displayed device-login URL, and enter the code.
   - **Anthropic:** paste an Anthropic API key. Verso verifies it before saving it in the isolated Hermes profile.
3. Return to the chat, choose one of the now-available models, and send a message.

Provider credentials remain in the local Hermes profile. They are not sent to the Verso backend in local mode.

## Runtime and network boundary

Verso has one codebase and three runtime modes:

| Mode | Purpose | Verso account/backend | Sentry and updates | State root |
| --- | --- | --- | --- | --- |
| `local` | Community/source default | Disabled | Disabled | `runtime/local` |
| `byo` | Reserved bring-your-own-provider mode | Disabled | Disabled | `runtime/byo` |
| `managed` | Verso's hosted product | Enabled | Enabled | Existing managed/account state |

The native app resolves `VERSO_RUNTIME_MODE` first, then the mode embedded in its Info.plist. Missing, empty, or invalid values fail closed to `local`. The selected mode is passed to the sidecar, which independently refuses managed URLs and sessions outside `managed` mode.

Local mode can still make network requests that you explicitly ask for—for example to Anthropic, OpenAI, websites used by browser tools, or custom MCP servers. It does not contact Verso's managed backend, Privy flow, Sentry project, or Sparkle feed.

## Local data and logs

Local and managed launches do not share application state.

| Data | Location |
| --- | --- |
| Local chats, connections, memory, browser data, and Hermes home | `~/Library/Application Support/Verso/runtime/local/` |
| BYO state | `~/Library/Application Support/Verso/runtime/byo/` |
| Sidecar log | `~/Library/Logs/verso/sidecar.log` |
| Python bytecode cache | `~/Library/Caches/Verso/python-bytecode/` |

To start again with empty local state without permanently deleting the old data, quit Verso and move the `runtime/local` directory somewhere else. A later managed launch will continue to see its original Keychain session and managed profile.

## Troubleshooting

### `node not found`

Confirm Node is executable at one of the paths checked by the app:

```sh
ls -l /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node 2>/dev/null
```

On Apple Silicon, installing Node with Homebrew normally provides `/opt/homebrew/bin/node`.

### `Hermes CLI not found`

Confirm that one of these works:

```sh
command -v hermes
ls -l ~/.local/bin/hermes ~/.hermes/hermes-agent/venv/bin/hermes 2>/dev/null
```

For a custom installation, add `VERSO_HERMES_COMMAND=/absolute/path/to/hermes` to the Xcode scheme environment.

### The sidecar or Hermes does not become ready

Inspect the sidecar log:

```sh
tail -n 200 "$HOME/Library/Logs/verso/sidecar.log"
```

Also make sure another Verso or Hermes gateway is not still running. Quit the other process before retrying.

### The UI looks stale after a frontend change

Regenerate the checked-in WebView assets:

```sh
./scripts/build-chat-ui.sh
```

### An old Xcode scheme still opens managed sign-in

Remove any `VERSO_RUNTIME_MODE=managed` entry from the scheme environment, or explicitly set:

```text
VERSO_RUNTIME_MODE=local
```

### Upstream Hermes and Verso are temporarily incompatible

The lightweight Debug path uses your installed Hermes CLI. Official Verso builds instead use a pinned Hermes commit with the patches under `desktop/runtime-patches/`.

To reproduce that exact runtime locally, build the generated bundle and then relaunch the Debug app:

```sh
./scripts/build-runtime-bundles.sh
```

This is a large, slower one-time build. It downloads the pinned Node, Python, and Hermes inputs into the gitignored `desktop/runtime-bundles/` directory and runs a gateway smoke test. Normal UI-only development does not require rebuilding it.

## Development

### Test the desktop components

```sh
(cd desktop/orchestrator && npm test && npm run typecheck)
(cd desktop/chat-ui && npm test && npm run typecheck)

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
    -project verso.xcodeproj \
    -scheme verso \
    -destination 'platform=macOS' \
    -derivedDataPath DerivedData \
    CODE_SIGNING_ALLOWED=NO

./scripts/check-runtime-profiles.sh
bash scripts/check-licensing.sh
bash scripts/check-repository-hygiene.sh
```

The managed backend has its own suite:

```sh
(cd backend && npm ci && npm test && npm run typecheck)
```

### Run the sidecar and chat UI in a browser

This path is useful for WebView work. It deliberately opts out of the native app's per-launch sidecar token and must only be used for local development:

Use a fresh Terminal shell without `VERSO_*` overrides left over from managed or bundled-runtime development.

```sh
# Terminal 1
cd desktop/orchestrator
VERSO_RUNTIME_MODE=local \
VERSO_ALLOW_UNAUTHENTICATED_SIDECAR=1 \
  npm run serve

# Terminal 2
cd desktop/chat-ui
npm run dev
```

Open the Vite URL with the sidecar port printed by Terminal 1 as the `port` query parameter, for example `http://localhost:5173/?port=43123`. Because this development launch is explicitly unauthenticated, you can also verify the active mode directly:

```sh
curl http://127.0.0.1:43123/diagnostics
```

The response's `runtime.mode` must be `local`.

### Runtime overrides

These are optional Xcode scheme or shell environment variables:

```sh
# Explicit Hermes CLI instead of auto-detection
VERSO_HERMES_COMMAND="/absolute/path/to/hermes"
VERSO_HERMES_ARGS='["gateway","run"]'

# Launch working directory for a source checkout
VERSO_HERMES_CWD="/absolute/path/to/hermes/repo"

# Override the isolated Hermes home
VERSO_HERMES_HOME="/absolute/path/to/hermes-home"

# Use an already-running gateway instead of letting Verso start one
VERSO_HERMES_MANAGED=false
VERSO_HERMES_GATEWAY_URL="http://127.0.0.1:8642"

# Gateway startup timeout
VERSO_HERMES_STARTUP_TIMEOUT_MS="90000"

# Put all local/BYO state under a throwaway root
VERSO_LOCAL_STATE_ROOT="/absolute/path/to/verso-state"
```

Explicit path overrides remain authoritative, so use throwaway paths in tests rather than pointing a local run at managed data.

## Managed product development

The hosted Verso product remains in this repository but must be selected explicitly:

```sh
# Product-like development launch
VERSO_RUN_PROFILE=managed ./scripts/conductor-run-verso.sh

# Official managed Release build
./scripts/build-managed-release.sh
```

For managed Cmd+R development in Xcode, add `VERSO_RUNTIME_MODE=managed` to the scheme environment. Managed service identifiers are committed configuration rather than secrets; runtime gates prevent local/BYO launches from using them. Signing credentials, provider secrets, and the Sparkle private key remain outside git.

Release signing, notarization, runtime-bundle, and appcast instructions live in [scripts/README.md](scripts/README.md).

## Conductor

The shared `.conductor/settings.toml` runs `local` and uses `scripts.run_mode = "nonconcurrent"` because profiles and memory are durable per-user resources. Shared repository settings appear in Conductor only after they are merged to the remote default branch.

A developer working on the managed product can override that behavior on one machine with a gitignored repository-root `.conductor/settings.local.toml`:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
setup = "./scripts/conductor-setup.sh"
run_mode = "nonconcurrent"

[scripts.run.verso]
command = "./scripts/conductor-run-verso.sh"
default = true
icon = "monitor"
available_in = [ "local" ]
```

The launcher defaults to `managed` when the personal override does not pass `VERSO_RUN_PROFILE`; the committed shared action passes `VERSO_RUN_PROFILE=local` explicitly.

Conductor workspaces reuse the repository root's large, gitignored runtime bundle through a validated symlink. If setup reports a missing or stale bundle, repair it from the repository root with `./scripts/build-runtime-bundles.sh`.

## Architecture

- `desktop/macos/` — SwiftUI macOS shell and process lifecycle
- `desktop/orchestrator/` — local Node sidecar for Hermes, persistence, tools, and streaming
- `desktop/chat-ui/` — React UI embedded in the native app
- `desktop/runtime-patches/` — Verso patches applied to the pinned Hermes runtime
- `backend/` — hosted API used only by managed mode
- `frontend/` — hosted web/auth frontend used only by managed mode

## Clean-machine acceptance checklist

Before the first public release, follow this README verbatim on a Mac that has never run Verso:

- [ ] Confirm the documented macOS, Xcode, Node, and architecture requirements
- [ ] Clone the public repository without copying any dotfiles or runtime bundle
- [ ] Run only the documented dependency and Hermes installation commands
- [ ] Build and launch the default Debug app
- [ ] Reach the main UI without a Verso or Privy sign-in
- [ ] Connect Codex and complete one chat
- [ ] Reset local state, connect Anthropic, and complete one chat
- [ ] Restart the app and confirm local sessions and provider configuration persist
- [ ] Confirm Settings reports `Local` and has no managed account or sign-out controls
- [ ] Confirm the Check for Updates menu item is absent
- [ ] Inspect the sidecar log for startup errors or unexpected managed-service requests
- [ ] Confirm all created data is under the documented local state root
- [ ] Run once with stale managed backend/session environment variables and confirm they are ignored
- [ ] Record every missing prerequisite, unclear instruction, warning, and first-run delay before calling the quickstart verified

## Repo

This repo is `macos-agent-orchestrator`. verso is the product.

## License

Copyright (C) 2026 Hugo Sanchez.

Verso is licensed under the [GNU Affero General Public License, version 3 only](LICENSE) (`AGPL-3.0-only`). If you modify Verso and let users interact with that modified version over a network, AGPL section 13 generally requires offering those users the corresponding source code. This is a practical summary, not legal advice.

Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
