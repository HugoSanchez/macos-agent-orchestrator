# Third-party notices

Verso-owned source code is licensed under the GNU Affero General Public
License, version 3 only (`AGPL-3.0-only`). Verso also distributes third-party
software and fonts under their respective licenses. The Verso license does not
replace or restrict those licenses.

## Directly bundled components

| Component | Version or revision | License | Included notice |
| --- | --- | --- | --- |
| IBM Plex | Bundled font files | SIL Open Font License 1.1 | `LICENSES/IBM-Plex-OFL-1.1.txt` |
| JetBrains Mono | Bundled font files | SIL Open Font License 1.1 | `LICENSES/JetBrains-Mono-OFL-1.1.txt` |
| Sentry Cocoa | 9.15.0 (`cef29e94feb00b1b712514443d6d70b09ef20355`) | MIT | `LICENSES/Sentry-Cocoa-MIT.txt` |
| Sparkle | 2.9.2 (`6276ba2b404829d139c45ff98427cf90e2efc59b`) | MIT and bundled external notices | `LICENSES/Sparkle.txt` |
| Hermes Agent | `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` | MIT | `LICENSES/Hermes-Agent-MIT.txt` |
| Python | 3.11.15 | Python Software Foundation License and historical notices | `LICENSES/Python-3.11.txt` |
| Node.js | 24.15.0 | MIT and bundled third-party notices | `Resources/node/LICENSE` in Release builds |

The IBM Plex and JetBrains Mono notices cover the copies used by the native
macOS shell, the embedded chat UI, and the hosted frontend.

## Embedded runtime dependencies

Release builds preserve dependency-specific license files alongside the code
that uses them:

- JavaScript dependencies are installed under
  `Resources/orchestrator/node_modules/` with their package license files.
- Python dependencies are installed under
  `Resources/site-packages/<architecture>/site-packages/`; package metadata and
  license files are retained in their `.dist-info` directories.
- The embedded Python standard-library license is retained at
  `Resources/python/<architecture>/python/lib/python3.11/LICENSE.txt`.
- Bundled Hermes skills that carry separate licenses retain those license files
  in the skill directories.

Source and build provenance for the pinned runtimes is recorded in
`scripts/runtime-config.sh` and `scripts/build-runtime-bundles.sh`.

This inventory describes components shipped directly by Verso. Package-manager
lockfiles contain the complete dependency graph for source builds; each package
continues to be governed by its own license and notices.
