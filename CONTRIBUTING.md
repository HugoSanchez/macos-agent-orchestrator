# Contributing to Verso

Verso is an actively evolving, maintainer-led project. Bug reports,
documentation improvements, and focused fixes are welcome. Contributions are
reviewed for correctness, product fit, and ongoing maintenance cost. Review
times vary, and not every proposal will be accepted.

## Before you start

Small bug fixes and documentation corrections can go straight to a pull
request. For new features, integrations, UI redesigns, or substantial
refactors, open an [issue](https://github.com/HugoSanchez/macos-agent-orchestrator/issues)
first and agree on the scope with a maintainer before implementing it.

Describe the problem you want to solve and who it affects. This helps us
decide whether a change belongs in Verso before you spend time building it.
Keep discussions respectful and focused on the work.

## Report a bug

Search existing issues first. Include:

- The Verso version or source commit, macOS version, and whether you use a
  managed release or a local source build.
- Steps to reproduce the problem.
- What you expected and what happened instead.
- Relevant error messages or screenshots, with credentials and personal data
  removed.

## Make a change

1. Fork the repository and create a branch from `main` in your fork.
2. Follow the [source setup instructions](README.md#run-from-source). The
   desktop currently supports Apple Silicon Macs running macOS 14 or newer.
3. Keep each pull request focused on one problem. Follow the surrounding
   code's conventions and avoid unrelated cleanup or new dependencies.
4. Add or update tests when behavior changes, and update documentation when
   setup or user-facing behavior changes.
5. Open a pull request targeting `main`. Explain the problem, the change, and
   how you verified it. Link the relevant issue and include screenshots for
   visible UI changes.

## Check your work

Run the checks for the components you changed, from the repository root:

```sh
(cd desktop/orchestrator && npm test && npm run typecheck)
(cd desktop/chat-ui && npm test && npm run typecheck)
(cd server/backend && npm test && npm run typecheck)
(cd server/frontend && npm run typecheck && npm run build)
```

For embedded chat UI changes, run `./scripts/build/build-chat-ui.sh` and
include the updated assets in `desktop/macos/chat-ui/`. Native test commands
and runtime build instructions are in [Development](README.md#development).

If you edit `packages/composio`, run `npm ci` in both `server/backend` and
`desktop/orchestrator` before their checks: each installs a snapshot of that
shared package. See [connected-app development notes](docs/connected-apps.md#implementation-and-development).

Documentation-only changes do not require application tests. Check links and
commands instead. In your pull request, state which checks you ran and any
you could not run; do not describe untested behavior as verified.

## License

Submit contributions under the project's existing [AGPL-3.0-only license](LICENSE).
Only include material you have the right to contribute, and preserve required
third-party license notices.
