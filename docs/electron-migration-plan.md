# Electron Migration Plan

Status: proposed  
Audience: maintainers and contributors  
Decision owner: Verso maintainers  
Architecture review: agreed by Codex and Claude Code (Fable 5), with a dedicated simplicity review on 2026-08-22

## Decision

Open-source the current macOS application before completing an Electron
migration. Describe it honestly as a macOS alpha, not a cross-platform release,
and stop adding substantial new product UI to the Swift shell.

Start the migration with a small Electron-shell spike. Treat Windows/Linux
runtime portability as a parallel workstream, because CPython and Hermes
bundling would be required under any cross-platform shell and should not be
allowed to confuse the Electron decision.

Plan against approximately 14 person-weeks for one engineer, with a plausible
range of 11-16 person-weeks to reach a credible macOS, Windows, and Linux beta.
Replace this estimate with measured work after the two spikes.

## Principles

The migration should preserve these invariants:

- The existing Node orchestrator, loopback HTTP/SSE API, and Hermes supervisor
  remain the product backend.
- Existing macOS users keep their conversations, memories, configuration, and
  credentials.
- The renderer remains sandboxed and has no direct Node access.
- Release artifacts contain the exact runtime bytes that passed smoke tests.
- Native runtimes and dependencies are built on their target operating system.
- Swift and Electron are not maintained as permanent production shells.

Anything not needed to preserve one of those invariants should be deferred.

## Minimal architecture

```text
Electron main
├── Window and app lifecycle
├── Menus, deep links, updates, notifications, sleep/wake
├── Secure renderer asset protocol and narrow preload bridge
└── Existing sidecar supervisor semantics
    └── Bundled standalone Node 24
        └── Existing orchestrator
            ├── SQLite stores and embeddings
            ├── Existing loopback HTTP/SSE API
            └── Bundled CPython + Hermes

Sandboxed React renderer
├── Existing chat, settings, catalogs, schedules, and browser UI
├── New web session sidebar and onboarding
└── Existing ShellState / ShellCommand / ShellAction contract
```

### Keep the standalone Node sidecar

Electron main initially launches the same bundled Node 24 runtime and
orchestrator that the Swift shell launches today. It keeps the existing stdout
ready-handshake, parent-PID watcher, restart policy, and POSIX shutdown flow.

This preserves `node:sqlite`, the Hermes child runner's Node IPC channel,
`process.execPath` re-spawning, and `#!/usr/bin/env node` tools such as
`agent-browser`. It also lets the production Electron binary disable its
`runAsNode` fuse.

Moving the orchestrator into an Electron utility process is out of scope. It can
be reconsidered later only if it produces a measured benefit.

### Keep HTTP/SSE

The React client continues to call the authenticated loopback HTTP API and read
SSE streams. Do not create an Electron IPC version of the API.

The packaged renderer loads from a standard, secure custom origin such as
`verso-app://app`, not `file://`. Add that exact origin to the orchestrator's
CORS allowlist while continuing to reject `Origin: null`. The preload bridge
provides the per-launch sidecar port and token to the renderer. If the selected
Chromium version sends a Private/Local Network Access preflight, answer it only
for this exact origin.

Use `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
Expose named, validated shell operations through `contextBridge`; never expose
raw `ipcRenderer`, arbitrary filesystem/process access, or unrestricted URL
opening.

### Package the sidecar as plain resources

The complete sidecar tree—Node, orchestrator, Python, site-packages, Hermes,
defaults, and native libraries—ships as `extraResources`, outside ASAR, in the
same logical layout used today. ASAR may contain Electron main, preload, and
renderer code only.

Do not compile the orchestrator as part of this migration. Continue launching
it with pinned `tsx`; move `tsx` into production dependencies so release builds
can omit unrelated development packages. Compiling the orchestrator can be a
separate, independently tested cleanup later.

## Initial support matrix

| Operating system | Architecture | Distribution |
| --- | --- | --- |
| macOS | ARM64 | Signed/notarized DMG and ZIP |
| Windows | x64 | Signed NSIS installer |
| Linux | x64 | AppImage, with DEB where AppImage sandboxing is unsuitable |

The macOS DMG is for first installs and the final Sparkle transition. The ZIP is
used by subsequent Electron updates. Defer macOS x64, Windows/Linux ARM64,
stores, additional Linux formats, and automatic Linux updates until demand
justifies them.

## Phase 0: public baseline

1. Close the remaining open-source-readiness gaps. Repository hygiene,
   licensing checks, secret scanning, and self-hosting documentation are already
   substantially in place; do not re-scope completed work.
2. Publish the repository as a pre-stable macOS alpha and link this plan from a
   public tracking issue.
3. Freeze substantial new SwiftUI product UI. Continue bug fixes and release
   maintenance.
4. Keep `main` releasable and land the migration incrementally.
5. Use `electron-builder` and `electron-updater` unless the shell spike finds a
   concrete blocker.
6. Start Windows code-signing procurement with Phase 1b. It is required for any
   Windows shell, but certificate lead time must not block open-sourcing.
7. Before changing shells, move `tsx` into production dependencies and install
   the sidecar with `--omit=dev`. Validate that cleanup through the current
   macOS DMG smoke gate.

A broad announcement that Verso is available to everyone waits for the
cross-platform beta. Repository visibility does not.

## Phase 1a: Electron-shell spike

Time-box: 2-4 working days, macOS-first, with a quick shell-only confirmation on
Windows and Linux.

Create `desktop/electron` alongside `desktop/macos` and prove:

1. A packaged, sandboxed renderer loads from `verso-app://app`.
2. Electron starts bundled Node and parses the existing ready-handshake.
3. The renderer completes an authenticated request and full SSE stream while
   opaque/null origins remain rejected.
4. The packaged sidecar opens SQLite/FTS5, loads the real embedding model from
   network and offline cache, and exercises representative native/WASM paths.
5. Bundled Hermes starts, streams one response, and exits cleanly through the
   current POSIX shutdown path.
6. Sidecar resources resolve correctly from the installed application, not
   only the development directory.

Record startup time, idle memory, package size, and any Chromium/CORS behavior.
This spike answers whether Electron is a sound shell for Verso. It does not
productionize Windows/Linux Python bundles.

Proceed if the shell works reliably with the existing standalone sidecar.

## Phase 1b: portable-runtime workstream

Start in parallel with Phase 1a. Build hand-assembled proofs first, then turn
them into repeatable target-native jobs.

For Windows x64 and Linux x64, prove:

- Bundled standalone Node and target-specific orchestrator dependencies.
- Relocatable CPython 3.11 and target-native Hermes dependencies.
- Hermes boot and one streamed response.
- SQLite/FTS5, embeddings, document conversion, and browser automation.
- Persistent data outside the application install directory.
- Clean process-tree shutdown without Node, Python, or browser orphans.

On Windows, add an authenticated `POST /shutdown` route because process
termination does not provide POSIX signal semantics. After a timeout, use a
validated tree-scoped forced cleanup such as `taskkill /T /F`. The
orchestrator's own Windows child-termination path must also terminate the Hermes
runner tree, not only its immediate PID; otherwise a successful orchestrator
shutdown can still strand Python before the shell fallback runs. Add a Job
Object only if testing shows these simpler tree-scoped paths still leave
descendants behind.

On Linux, test Chromium sandbox operation on supported desktop distributions,
including Ubuntu configurations that restrict unprivileged user namespaces.
Never ship with `--no-sandbox`; prefer a DEB on systems where AppImage cannot
preserve the sandbox instead of maintaining speculative workarounds.

A target that fails this workstream slips; it does not retroactively make the
Electron-shell decision wrong.

## Phase 2: small platform-neutral deltas

Extend the existing `desktop/orchestrator/src/app/local-state.ts`; do not build
a second path abstraction. Electron main sets `VERSO_LOCAL_STATE_ROOT` from OS
conventions and keeps Chromium's cache/session data separate from Verso's
domain data.

Fix the remaining concrete assumptions:

- Use `path.delimiter` for `PYTHONPATH` and `PATH` composition.
- Resolve Windows `.exe` names and Windows/Linux runtime layouts.
- Add Windows/Linux browser discovery.
- Implement the cross-platform connector-secret backend described below.
- Run orchestrator tests and typechecking on macOS, Windows, and Linux.

Keep current environment-variable path overrides for tests and advanced users.

## Secrets

Do not introduce a new runtime control protocol solely for secrets.

- The managed session remains owned by the shell. Electron protects it with
  `safeStorage`, seeds it at sidecar launch, and pushes live changes through the
  existing authenticated `/managed/session` API.
- Custom-connector bearer tokens remain owned by the orchestrator. Store them
  in one atomically written AES-GCM file. Electron protects the random file key
  with `safeStorage` and passes the unwrapped key in the sidecar launch
  environment alongside the existing sidecar auth/session values.
- Select the encrypted-file backend only when Electron supplies that launch
  value. Otherwise retain the existing `/usr/bin/security` backend so Swift-era
  builds remain unchanged and releasable during the transition.
- On macOS, import the current `com.verso.managed-session/current` and
  `com.verso.custom-connectors` entries through fixed-argument
  `/usr/bin/security` calls. Make import idempotent and do not delete the legacy
  entries during the transition window.
- On Linux, detect and disclose a weak `safeStorage` backend. Do not claim
  strong at-rest protection when Electron reports `basic_text`.

This matches the current same-user threat model: Hermes already consumes
credentials from its profile files and child-process environment. A private
key-handoff protocol would not materially close that broader boundary.

## Phase 3: webify product UI

Move these SwiftUI surfaces into `desktop/chat-ui` while the Swift shell still
hosts the webview:

- Session sidebar, working/unread state, and session actions.
- Sign-in, callback completion, sign-out, and onboarding.
- Sidebar sections, theme, and window-level layout.

Reuse the existing `ShellState`, `ShellCommand`, `ShellAction`, and browser-mode
host. Platform-specific window controls still go through the shell boundary.

Do not bridge Sparkle's update state into React. Build the React update UI once
against `electron-updater` in Phase 4.

## Phase 4: Electron shell

Implement only the OS-host responsibilities:

- Main lifecycle and sandboxed `BrowserWindow`.
- Secure custom asset scheme and restrictive CSP.
- Narrow preload bridge and existing shell-state protocol.
- Bundled-sidecar launch, ready parsing, restart, logs, and shutdown.
- Production `verso://` and isolated development `verso-dev://` deep links.
- Single-instance behavior, menus, keyboard shortcuts, file dialogs, external
  URL allowlisting, notifications, and supported badges.
- `powerMonitor` forwarding to the existing `verso:system-sleep` and
  `verso:system-wake` renderer events.
- Platform-appropriate window chrome.
- Update UI and `electron-updater` integration.
- Existing crash/telemetry hooks, annotated with platform, architecture, app
  version, and runtime-bundle version while excluding secrets and user content.

Disable production Electron fuses for `runAsNode`, Node CLI inspection, and
unrestricted `NODE_OPTIONS`. Record the fuse values in the packaged smoke test.

## Phase 5: macOS transition

1. Package and sign/notarize Electron DMG and ZIP artifacts under the existing
   `xyz.itsverso.app` identifier and Developer ID team.
2. Point Electron at the existing `~/Library/Application Support/Verso` data.
3. Before first Electron launch, create one recoverable backup of mutable SQLite
   and small JSON state. Do not introduce shell-migration database schemas.
4. Import Keychain credentials idempotently. Minor Swift UI preferences may
   reset; they are not user content.
5. Rehearse the update using copies of real profiles and the oldest supported
   public build.
6. Publish one final Sparkle update whose Electron `CFBundleVersion` is greater
   than every Swift build and whose archive uses the existing Sparkle EdDSA key.
7. Dogfood, then ship an opt-in preview, then move macOS users.

Rollback means reinstalling the still-published previous signed DMG and
restoring the backup. Avoid unrelated database schema changes during the shell
transition; do not impose a permanent dual-schema compatibility framework.

Once the supported transition window ends, remove the Swift shell from the
production build instead of maintaining two shells.

## Phase 6: Windows and Linux betas

Ship each target only after its Phase 1b runtime proof passes. Add OS-specific
work only when that target needs it:

- Windows signing, installer/upgrade/uninstall tests, process-tree cleanup,
  paths, deep links, and SmartScreen observation.
- Linux AppImage/DEB packaging, glibc baseline, keyring disclosure, desktop
  integration, and sandbox tests.

If browser automation is unavailable on one target, label that limitation
explicitly. Core chat, persistence, memory, and clean process lifecycle cannot
silently degrade.

## CI and releases

Keep CI proportional to feedback speed:

- Every pull request: repository hygiene plus unit tests and typechecking on a
  macOS/Windows/Linux matrix; build Electron main/preload/renderer artifacts.
- Nightly and release candidates: build target-native runtime bundles, package
  applications, install/extract them in clean environments, and run Hermes,
  SQLite, embeddings, attachment, persistence, and process-cleanup smoke tests.
- Release only artifacts carrying a matching smoke-pass stamp, preserving the
  current "the shipped bytes actually booted" invariant.
- Release workflow: verify signing/notarization and generate per-platform
  update metadata automatically.

Do not commit generated Electron renderer assets. The current Xcode embedded-
asset drift check disappears with the Swift shell because Electron packaging
builds those assets from source.

## Estimate

| Workstream | Person-weeks |
| --- | ---: |
| Electron-shell spike | 0.5-1 |
| Windows/Linux runtime proofs and production bundle jobs | 2-4 |
| Platform-neutral orchestrator deltas and test matrix | 1-2 |
| React sidebar, onboarding, and remaining native UI | 2-4 |
| Electron shell and OS integrations | 2-3 |
| macOS transition, target packaging, and beta QA | 2-3 |

Planning target: approximately 14 person-weeks, with an 11-16 person-week
range. Windows runtime findings remain the largest source of variance.

## Completion criteria

The migration is complete when:

- Existing macOS users update without losing user content or credentials.
- Fresh installs require no system Node, Python, or Hermes installation.
- macOS ARM64, Windows x64, and Linux x64 pass packaged runtime smoke tests.
- Core chat, persistence, memory, authentication, updates, and process cleanup
  pass platform QA; optional feature gaps are explicitly documented.
- The renderer is sandboxed and the preload surface has been security-reviewed.
- Artifacts are signed where applicable and macOS is notarized.
- The Swift shell is no longer required for production releases.

## Immediate next actions

1. Finish and publish the macOS-alpha open-source readiness work.
2. Open a public Electron migration tracking issue linking this plan.
3. Run the Phase 1a Electron-shell spike.
4. Start Phase 1b Windows/Linux runtime proofs in parallel.
5. Replace estimates and unresolved target support with measured results.
