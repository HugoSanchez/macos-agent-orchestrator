# Backend Cleanup Inventory

Date: 2026-05-14

## Decision

The working product path is Hermes using its own Codex/OpenAI auth and model
configuration. The backend should not be the default model proxy. Its durable
responsibilities are:

1. Managed account auth and session validation.
2. Composio API key custody, connection UX, and Tool Router search/schema/execute.
3. Health checks and database plumbing needed by the two items above.

OpenRouter/custom-provider support should not remain in the main runtime as
partially active code. If we revisit it, it should come back as an isolated
fallback with explicit contract tests against Hermes tool calling.

## Implementation Status

First deletion pass completed: backend inference, usage, runtime-config,
OpenRouter config, desktop `/llm/v1`, and the account UI usage dependency have
been removed from active runtime code. Second deletion pass completed: Composio
hosted MCP session minting, desktop local Composio SDK fallback, and Composio
probe scripts were removed. The remaining explicit decision is whether/when to
drop the legacy `inference_requests` table.

## Backend Inventory

| Path | Status | Target action | Rationale |
|---|---|---|---|
| `backend/src/index.ts` | Keep | Keep | Process entrypoint. |
| `backend/src/server.ts` | Keep, simplify | Remove inference/usage/runtime-config wiring after desktop callers are removed. | Still owns Fastify setup, auth, health, and Composio route registration. |
| `backend/src/config.ts` | Keep, simplify | Keep `HOST`, `PORT`, `DATABASE_URL`, `PRIVY_*`, `AUTH_SESSION_LIFETIME_DAYS`, `WEB_BASE_URL`; remove OpenRouter and managed-model settings. | Model/provider config belongs to Hermes/Codex, not backend. |
| `backend/src/routes/health.ts` | Keep | Keep | Low-risk operational endpoint. |
| `backend/src/routes/auth.ts` | Keep | Keep | Needed for Privy exchange, `/v1/me`, and session revoke. |
| `backend/src/routes/composio.ts` | Keep, simplified | Keep authenticated Composio connection and Tool Router search/schema/execute routes. | Backend still protects Composio key and maps requests to authenticated user id. |
| `backend/src/routes/inference.ts` | Delete | Remove route and tests. | Only supports backend model proxy/OpenRouter path. |
| `backend/src/routes/usage.ts` | Delete or replace | Remove once account UI no longer calls `/v1/usage/summary`; replace with simpler account summary if needed. | Cost usage is tied to backend-paid inference. |
| `backend/src/routes/runtime-config.ts` | Delete | Remove once account UI stops calling `/v1/runtime-config`. | Backend no longer chooses Hermes model/default provider. |
| `backend/src/composio/service.ts` | Keep, simplify | Keep Tool Router search/schema/execute, connection list/request/status, toolkit search. Split later only if it becomes hard to reason about. | This is the core backend value: key custody plus per-user Composio calls. |
| `backend/src/auth/*` | Keep | Keep. | Current account/session boundary. |
| `backend/src/db/client.ts` | Keep | Keep. | Shared DB construction. |
| `backend/src/db/health.ts` | Keep | Keep. | Health route support. |
| `backend/src/db/migrate.ts` | Keep | Keep. | Migration runner. |
| `backend/src/db/auth-store.ts` | Keep | Keep. | Durable auth/session store. |
| `backend/src/db/inference-store.ts` | Delete | Remove with inference route. | Only persists backend model proxy requests. |
| `backend/src/db/schema.ts` | Keep, simplify | Keep auth tables. Remove `inference_requests` with a migration after confirming data retention requirements. Revisit `entitlements`. | Auth schema stays; inference schema belongs to removed proxy. |
| `backend/src/inference/*` | Delete | Remove all. | OpenRouter client, limiter, breaker, memory store, and types are only for backend-paid inference. |

## Backend Scripts

| Path | Status | Target action | Rationale |
|---|---|---|---|
| `backend/scripts/smoke-db.ts` | Keep | Keep. | DB operational check. |
| `backend/scripts/issue-test-session.ts` | Keep | Keep for now. | Useful for exercising managed auth locally. |
| `backend/scripts/probe-composio-mcp.ts` | Deleted | Removed after bridge stabilization. | Debug probe, not product code. |
| `backend/scripts/probe-composio-direct-mcp.ts` | Deleted | Removed after direct MCP experiment was abandoned. | Direct MCP experiment should not live in product backend. |
| `backend/scripts/baseline-usage.ts` | Delete | Remove with inference store. | Only reports backend OpenRouter spend. |
| `backend/scripts/recent-inferences.ts` | Delete | Remove with inference store. | Only reports backend OpenRouter spend. |

## Backend Tests

| Path | Status | Target action |
|---|---|---|
| `backend/test/auth-*.test.ts` | Keep | Keep. |
| `backend/test/health.test.ts` | Keep | Keep. |
| `backend/test/config.test.ts` | Keep, update | Update expectations after config is simplified. |
| `backend/test/composio-*.test.ts` | Keep | Keep and tighten around direct bridge contract. |
| `backend/test/inference.test.ts` | Delete | Remove with inference route. |
| `backend/test/rate-limiter.test.ts` | Delete | Remove with inference subsystem. |
| `backend/test/circuit-breaker.test.ts` | Delete | Remove with inference subsystem. |
| `backend/test/usage.test.ts` | Delete or replace | Remove with usage route unless account UI needs a simpler replacement. |
| `backend/test/runtime-config.test.ts` | Delete | Remove with runtime-config route. |

## Adjacent Desktop Cleanup Required

These are not backend files, but backend deletion should include them or the
desktop app will keep calling dead endpoints.

| Path | Status | Target action | Rationale |
|---|---|---|---|
| `desktop/orchestrator/src/http/llm-proxy.ts` | Delete | Remove `/llm/v1/*` proxy routes. | The proxy is the custom-provider path that broke Hermes behavior. |
| `desktop/orchestrator/src/http/server.ts` | Keep, simplify | Stop registering `buildLlmProxyRoutes`. | Keeps chat, managed account, connections, skills, and Composio bridge routes. |
| `desktop/orchestrator/src/integrations/managed-backend-client.ts` | Keep, simplify | Keep session/account/auth and Composio support; remove `getRuntimeConfig`, `getUsageSummary`, `forwardChatCompletion`, and `streamInference`. | Backend client should not expose backend model proxy methods. |
| `desktop/orchestrator/src/account/managed-account.ts` | Keep, simplify | Remove usage/runtime-config calls or replace them with plain account status. | Account page can show signed-in state without model spend. |
| `desktop/orchestrator/src/hermes/hermes-supervisor.ts` | Keep, simplify | Remove explicit custom-provider override path once `/llm/v1` is gone. Keep auth-store sync and managed profile preservation. | Hermes should preserve Codex model config. |
| `desktop/orchestrator/scripts/validate-llm-proxy.ts` | Delete | Remove with proxy. | Experiment-only validation. |
| `desktop/orchestrator/test/llm-proxy.test.ts` | Delete | Remove with proxy. | Proxy tests become obsolete. |
| `desktop/orchestrator/test/managed-backend-client.test.ts` | Keep, update | Remove tests for usage/runtime-config/inference methods. | Keep auth/session behavior coverage. |
| `desktop/runtime-bundles/orchestrator/*` | Defer/generated | Rebuild after source cleanup rather than hand-editing first. | Bundle should follow source. |

## Historical Dependency Notes

- `/v1/runtime-config` was called by `ManagedBackendClient.getRuntimeConfig`,
  then surfaced through `desktop/orchestrator/src/account/managed-account.ts`.
- `/v1/usage/summary` was called by `ManagedBackendClient.getUsageSummary`,
  then surfaced through `desktop/orchestrator/src/account/managed-account.ts`.
- `/v1/chat/completions` was used by the desktop `/llm/v1` proxy via
  `ManagedBackendClient.forwardChatCompletion` and `streamInference`.
- The old `/v1/composio/session` and `/composio/session` hosted MCP session
  path has been removed. Hermes now uses only the local `verso` MCP bridge.

## Deletion Order

1. Remove desktop `/llm/v1` proxy registration and backend `/v1/chat/completions`
   route together. Done.
2. Remove `ManagedBackendClient` inference methods and backend inference stores.
   Done.
3. Remove usage/runtime-config endpoints and simplify account UI responses. Done.
4. Remove OpenRouter/model/rate-limit config and dependencies. Done.
5. Migrate or leave-unused `inference_requests`; do not drop production data
   without an explicit retention decision. Deferred.
6. Revisit Composio hosted MCP session endpoints after confirming no live UI or
   Hermes path depends on them. Done.
