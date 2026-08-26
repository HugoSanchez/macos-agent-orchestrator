# Verso's Hermes patch boundary

Verso embeds a pinned Hermes commit and applies a small compatibility/product
layer at bundle time. These patches are intentionally not authentication
middleware: Hermes owns `API_SERVER_KEY`; Verso only launches it and forwards
that same runtime key to the local client.

The authoritative commit, dependency pins, and ordered patch inventory live in
[`scripts/runtime-config.sh`](../../../scripts/runtime-config.sh). Both the
release builder and CI call `scripts/apply-hermes-patches.sh`, which refuses to
run when an unlisted patch is present. After applying the set, CI boots the
gateway and exercises streaming plus the MCP OAuth routes.

## Patch contracts

1. `api-server-reasoning-stream.patch` — forwards Hermes reasoning callbacks
   through the API-server SSE response.
2. `codex-tool-schema-required.patch` — normalizes tool schemas for the Codex
   Responses API's stricter required-field rules.
3. `verso-browser-guardrails.patch` — lazily starts Verso's shared browser,
   pins each Hermes task to its own tab, rebinds tasks after Chrome restarts,
   closes ephemeral cron tabs, and keeps raw CDP access opt-in via
   `browser.expose_cdp_tool`.
4. `verso-cron-running-status.patch` — exposes Hermes' authoritative
   in-flight scheduler state on each cron API response.
5. `verso-gateway-mcp-oauth.patch` — adds the loopback MCP OAuth routes used by
   the desktop connection flow.
6. `verso-personal-assistant-prompts.patch` — adapts the upstream agent prompt
   for Verso's general personal-assistant surface.
7. `verso-web-routing.patch` — keeps read-only extraction available without
   provider credentials, routes known public URLs away from browser automation,
   and makes browser-driving opt-in for cron jobs.
8. `verso-request-overrides.patch` — supports per-request model and reasoning
   effort selected in the chat UI. It depends on patch 1.
9. `verso-tool-search-pinned.patch` — keeps essential tools visible when
   Hermes defers the remainder behind tool search.

`verso-web-routing-tests.patch` is a source-only companion containing upstream
regression tests. The patch helper applies it to Hermes source checkouts, but
skips it for release `site-packages` trees because wheels do not ship `tests/`.

## Updating Hermes

1. Change `HERMES_REF` in `scripts/runtime-config.sh`.
2. Rebase every patch against that exact commit; remove patches whose behavior
   has landed upstream.
3. Run the Hermes runtime-smoke CI job or build the runtime bundle locally.
4. Never add authentication state or key persistence to a patch. The desktop
   supervisor remains the sole process-level owner of Hermes' generated key.
