# Sidecar source layout

The sidecar is organized by product feature. `http/` is only the transport
boundary; it does not own chat, Hermes, memory, or persistence state.

- `app/` constructs long-lived services, registers routes, and owns process lifecycle.
- `http/` binds the local HTTP server and provides the small router.
- `chat/` owns product sessions, chat-turn presentation, attachments, and draft state.
- `hermes/` owns the managed Hermes process and gateway protocol.
- `memory/` owns local memory, chat capture, ingestion scheduling, and source adapters.
- `connections/` owns connected-app and custom-MCP configuration and HTTP surfaces.
- `browser/`, `crons/`, `models/`, `skills/`, and `account/` are independent features.
- `integrations/` contains clients for external Verso services.
- `shared/` contains infrastructure with no feature ownership.

Dependency direction:

1. `http/` delegates to `app/`.
2. `app/` is the composition root and may depend on every feature.
3. Feature routes depend on their services and the HTTP router.
4. Feature internals should use narrow interfaces when crossing feature boundaries.
5. Infrastructure modules must not depend on the application composition root.

Keep new source adapters under `memory/ingestion/sources/` and keep process startup
ordering in `app/create-runtime.ts`; `http/server.ts` should remain transport-only.
