# Verso

Verso is a native macOS app for running AI agents. It combines a SwiftUI app,
[Hermes Agent](https://github.com/NousResearch/hermes-agent), and an embedded
React chat interface.

[Download the latest release](https://github.com/HugoSanchez/macos-agent-orchestrator/releases/latest)

## Features

- Local chats and session history
- Codex through OpenAI device login
- Claude through your own Anthropic API key
- Hermes tools, skills, routines, memory, and browser automation
- Custom MCP connectors

## Run from source

Source builds use local mode. They do not require a Verso account or connect to
Verso's hosted backend, telemetry, or update feed.

### Requirements

- Apple Silicon Mac with macOS 14 or newer
- Xcode installed at `/Applications/Xcode.app`
- Git
- Node.js 24 and npm
- A Codex-enabled OpenAI account or an Anthropic API key

### 1. Clone and install dependencies

```sh
git clone https://github.com/HugoSanchez/macos-agent-orchestrator.git
cd macos-agent-orchestrator

(cd desktop/orchestrator && npm ci)
(cd desktop/chat-ui && npm ci)
```

### 2. Install Hermes

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.zshrc
hermes --version
```

You can review the installer or follow the
[manual Hermes setup guide](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
instead.

### 3. Build and run

```sh
open verso.xcodeproj
```

In Xcode, select the `verso` scheme and **My Mac**, then press **Cmd+R**.

When Verso opens, go to **Settings** and connect either Codex or Anthropic.
Return to the chat, select a model, and send a message.

## Local data

Source builds keep their state separate from the hosted Verso product.

| Data | Location |
| --- | --- |
| Chats, memory, connections, and browser data | `~/Library/Application Support/Verso/runtime/local/` |
| Sidecar log | `~/Library/Logs/verso/sidecar.log` |
| Python bytecode cache | `~/Library/Caches/Verso/python-bytecode/` |

Local mode may contact providers, websites, or MCP servers that you choose to
use. It does not contact Verso's account backend, Sentry project, or update
feed.

## Troubleshooting

If Verso cannot find Node, install it with Homebrew:

```sh
brew install node
```

If Verso cannot find Hermes, confirm the CLI is available:

```sh
command -v hermes
hermes --version
```

For startup errors, inspect the sidecar log:

```sh
tail -n 200 "$HOME/Library/Logs/verso/sidecar.log"
```

If the embedded chat interface looks stale after a UI change, rebuild it:

```sh
./scripts/build/build-chat-ui.sh
```

## Development

Run the main checks before opening a pull request:

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
```

The hosted backend and website have separate checks:

```sh
(cd backend && npm ci && npm test && npm run typecheck)
(cd frontend && npm ci && npm run typecheck && npm run build)
```

Official builds use a pinned, bundled Hermes runtime. Rebuild it only when you
change the runtime or need to reproduce a release build:

```sh
./scripts/build/build-runtime-bundles.sh
```

Release and notarization instructions are in
[scripts/README.md](scripts/README.md).

## Repository layout

- `desktop/macos/` — native SwiftUI app
- `desktop/orchestrator/` — local Node sidecar and Hermes integration
- `desktop/chat-ui/` — embedded React chat interface
- `desktop/runtime-patches/` — patches for the bundled Hermes runtime
- `backend/` — hosted API used by the managed product
- `frontend/` — hosted website and account UI

## License

Copyright (C) 2026 Hugo Sanchez.

Verso is licensed under the
[GNU Affero General Public License, version 3 only](LICENSE)
(`AGPL-3.0-only`). Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
