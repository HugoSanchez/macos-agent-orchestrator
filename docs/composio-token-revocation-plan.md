# Composio token revocation on disconnect

Status: implementation-ready plan  
Priority: public-release security gate  
Scope: Composio-backed connections only

## Outcome

When a user disconnects an integration, Verso must first ask Composio to revoke the connected account at the upstream provider and then delete Composio's connected-account record. A disconnect must never silently skip the revoke attempt.

When programmatic provider revocation is unsupported, Verso still deletes the credential-bearing connected-account record and removes Composio's active access path. The outcome is retained for internal diagnostics, but a successful disconnect remains a clean, silent user action. This does not make a claim about Composio's backup-retention policy.

This work does not delete already-ingested Verso data. That needs a separate product decision and implementation.

## Why this is needed

The current path is:

1. `SidebarStore.disconnectConnection` optimistically removes the row.
2. `SidebarAPIClient.disconnectConnection` sends `DELETE /connections/:id` to the local orchestrator.
3. `ConnectionsService.deleteConnection` calls the managed backend.
4. `DELETE /v1/composio/connections/:id` calls `ComposioConnections.delete`.
5. `ComposioConnections.delete` verifies ownership, best-effort disables the account, and calls `connectedAccounts.delete(id)`.

Composio documents provider revocation and record deletion as separate operations:

- `POST /api/v3.1/connected_accounts/{id}/revoke` revokes at the provider.
- `DELETE /api/v3.1/connected_accounts/{id}` removes the account from Composio.

The repository's `@composio/core` contract exposes `disable` and `delete`, but not `revoke`. Use the documented REST endpoint behind a narrow, injectable adapter rather than adding an unverified SDK method to the local type.

## Required behavior

### Successful automatic revocation

1. Authenticate the Verso session.
2. Normalize the authenticated user ID and connected-account ID.
3. Verify that the connected account belongs to that user before any mutation.
4. Call Composio's revoke endpoint.
5. After a confirmed revoke, best-effort disable and then delete the Composio account.
6. Invalidate the user's cached Composio Tool Router session only after deletion succeeds.
7. Remove the local connection/tombstone it as today.
8. Return a successful result with `providerRevocation: "revoked"`.

### Provider cannot revoke programmatically

Composio documents `400` for an unsupported toolkit and `409` for an account that is not in a revokable state.

1. Record a sanitized warning containing the connected-account ID, toolkit slug, and Composio status code. Do not log response bodies, tokens, API keys, or user data.
2. Best-effort disable and delete the Composio account so the credential-bearing record and active access path are removed.
3. Return success with `providerRevocation: "manual_action_required"`.
4. Remove the local row without presenting provider implementation details or follow-up instructions to the user.

Do not describe this state as fully revoked.

### Already absent

If revoke returns `404` after the ownership check, treat the upstream account as already absent, attempt the Composio delete idempotently, and return `providerRevocation: "already_absent"`. Normalize a `404` from that final delete as already deleted rather than failing the request.

The existing desktop behavior that treats a backend `404` as a successful local cleanup remains valid for a connection that disappeared before this request reached the backend.

### Retryable or configuration failure

For a network error, timeout, `401`, `403`, `429`, or `5xx` from the revoke endpoint:

- Do not disable or delete the Composio account.
- Do not invalidate the Tool Router session.
- Return a sanitized `502` or `503` to the desktop client.
- Let the existing optimistic UI rollback restore the connection row so the user can retry.

This ordering is deliberate. Disabling before revocation would hide the account from Verso's filtered connection list and could strand a credential that still needs a retry.

### Delete failure after revocation

If provider revocation succeeds but Composio deletion fails, return an error and do not invalidate the cached session. A retry is safe: a subsequent `409` from revoke is terminal and can proceed to deletion with `manual_action_required`. Log this case distinctly so it can be monitored.

## Transport contract

Add this shared logical result at each layer (the concrete type can be duplicated at the existing backend/orchestrator boundary, as current connection view types are):

```ts
interface DisconnectConnectionResult {
  connectedAccountId: string;
  composioAccountDeleted: true;
  providerRevocation: 'revoked' | 'already_absent' | 'manual_action_required';
}
```

Change both DELETE endpoints from an empty `204` to `200` JSON:

```json
{
  "disconnect": {
    "connectedAccountId": "ca_...",
    "composioAccountDeleted": true,
    "providerRevocation": "revoked"
  }
}
```

The result contains no provider payload, credentials, or user data.

## Implementation steps

### 1. Add a narrow Composio revoke adapter

Create `backend/src/composio/account-revoker.ts` with an interface and production implementation:

```ts
interface ConnectedAccountRevoker {
  revoke(connectedAccountId: string): Promise<ProviderRevocationResult>;
}

type ProviderRevocationResult =
  | { status: 'revoked' }
  | { status: 'already_absent' }
  | { status: 'manual_action_required'; upstreamStatus: 400 | 409 };
```

Production behavior:

- `POST https://backend.composio.dev/api/v3.1/connected_accounts/${encodeURIComponent(id)}/revoke`
- Send `x-api-key`, `Accept: application/json`, and no request body.
- Normalize `2xx`, `400`, `404`, and `409` to the result above.
- Convert auth, rate-limit, server, timeout, and network failures to sanitized `ComposioServiceError` instances.
- Use the injected `fetch` and `ComposioLog` dependencies so unit tests do not make network calls.
- Never include the API key or upstream response body in an error or log.

Add an optional `accountRevoker` dependency to `ComposioServiceDependencies`. Construct the production adapter from the normalized API key, injected fetch, and log. Unit tests should inject or mock this boundary.

### 2. Change the backend lifecycle

In `backend/src/composio/connections.ts`:

- Replace `userOwnsAccount(): boolean` for deletion with a helper that returns the owned `ConnectedAccountItem`; retain indistinguishable `404` behavior for missing and foreign IDs.
- Inject `ConnectedAccountRevoker` and `ComposioLog` through `ComposioConnectionsOptions`.
- Change `delete` to return `DisconnectConnectionResult`.
- Execute in this exact order: ownership check, revoke, best-effort disable, delete, session invalidation, return result.
- Emit one sanitized lifecycle event for `manual_action_required` and one for a post-revoke delete failure.
- Keep `onConnectionsChanged` after successful deletion only.

In `backend/src/composio/contracts.ts` and `backend/src/composio/service.ts`:

- Add/export the result types.
- Pass the adapter and logger into `ComposioConnections`.
- Return the result from `deleteConnection`.

In `backend/src/routes/composio.ts`:

- Return `200 { disconnect: result }` on success.
- Keep authentication and authenticated-user ownership behavior unchanged.
- Keep upstream implementation details out of client error messages.

### 3. Propagate the result through the local orchestrator

In `desktop/orchestrator/src/integrations/composio-bridge-client.ts`:

- Add `RemoteDisconnectConnectionResult`.
- Decode and return `{ disconnect: ... }` from the managed backend.

In `desktop/orchestrator/src/integrations/composio.ts`:

- Return the disconnect result from `ConnectionsService.deleteConnection`.
- Delete/tombstone the local connection only after the managed backend reports `composioAccountDeleted: true`.
- Preserve the existing backend-`404` stale-local-row cleanup behavior and synthesize `already_absent` for that path.

In `desktop/orchestrator/src/http/connections.ts`:

- Return `200 { disconnect: result }` rather than `204`.

### 4. Consume the result without changing the disconnect UX

In `desktop/macos/SidebarAPIClient.swift`:

- Add a decodable disconnect response/result.
- Return the result from `disconnectConnection(id:)`.

In `desktop/macos/SidebarStore.swift` and the connection UI:

- Preserve optimistic row removal and rollback on request failure.
- Treat every successful result identically in the UI and keep the row removed.
- Do not expose `manual_action_required` or provider-specific cleanup instructions to the user.
- Retain the result only for internal diagnostics and compatibility handling.

## Tests

### Backend unit tests

Extend `backend/test/composio-service.test.ts` to cover:

- Ownership is checked before revoke; foreign/missing IDs never call revoke, disable, or delete.
- Success calls revoke before disable/delete and invalidates only the owning user's cached session.
- Disable failure is best-effort after revocation and does not prevent deletion.
- `400` and `409` yield `manual_action_required`, still delete the account, and log no upstream body.
- `404` yields `already_absent` and still attempts idempotent deletion.
- Network, `401`, `403`, `429`, and `5xx` revoke failures do not call disable/delete or invalidate sessions.
- Delete failure after successful revoke is surfaced and does not invalidate sessions.
- IDs are trimmed and URL-encoded.
- The API key is sent only in the `x-api-key` header and never appears in thrown errors or logs.

Extend `backend/test/composio-routes.test.ts` to verify authenticated-user propagation, the `200` response schema, manual-action results, and sanitized failure mapping.

### Orchestrator tests

Extend `desktop/orchestrator/test/connections-service.test.ts` and the HTTP route tests to cover all three result statuses, local deletion only after backend success, stale-row `404` cleanup, and retention of the local row on a retryable failure.

### macOS tests

Add decoding tests for all result cases and store tests proving:

- confirmed revoke removes the row without a warning;
- manual-action-required remains internal and removes the row without a warning;
- transient failure restores the optimistic row.

## Release verification

Run the backend, orchestrator, and macOS test suites. Then test at least one Google OAuth account and one non-Google OAuth account in a non-production Composio project:

1. Connect the account through the normal Verso UX.
2. Confirm it appears in Verso and Composio.
3. Disconnect it in Verso.
4. Confirm the Composio account record is gone.
5. Confirm the grant is gone from the provider's connected-app/security page when automatic revocation is supported.
6. Confirm an old tool call cannot execute and reconnection is required.
7. Exercise a mocked unsupported-revocation response and verify the row disappears without a user-facing warning.

Do not test by disconnecting a real user's production account.

## Rollout and observability

- Ship behind `VERSO_COMPOSIO_REVOKE_ON_DISCONNECT` only if a staged backend rollout is needed; default it on before the public release and remove the flag after validation.
- Count outcomes (`revoked`, `already_absent`, `manual_action_required`, `revoke_failed`, `delete_failed`) without payloads or user content.
- Alert on sustained `revoke_failed` or `delete_failed` rates. A spike can indicate an expired Composio project key or API behavior change.
- Keep `scripts/revoke-composio-connections.sh` as an admin/incident tool, but align its failure policy and comments with the production flow after this implementation lands.

## Acceptance criteria

- Every owned Composio disconnect attempts provider revocation before deletion.
- No mutation occurs for a missing or foreign connected-account ID.
- Retryable revoke failures preserve the Composio record and produce a retryable UI failure.
- Unsupported programmatic revocation deletes Composio's credential record without exposing provider implementation details to the user.
- Successful deletion invalidates the user's Tool Router session; failed deletion does not.
- Tokens, API keys, request/response payloads, and upstream bodies never enter application logs or client responses.
- Automated tests cover ordering, ownership, each upstream status class, client propagation, and optimistic UI rollback.
- Real-provider release verification succeeds for the supported path.

## Likely files changed

- `backend/src/composio/account-revoker.ts` (new)
- `backend/src/composio/contracts.ts`
- `backend/src/composio/connections.ts`
- `backend/src/composio/service.ts`
- `backend/src/routes/composio.ts`
- `backend/test/composio-service.test.ts`
- `backend/test/composio-routes.test.ts`
- `desktop/orchestrator/src/integrations/composio-bridge-client.ts`
- `desktop/orchestrator/src/integrations/composio.ts`
- `desktop/orchestrator/src/http/connections.ts`
- relevant orchestrator route/service tests
- `desktop/macos/SidebarAPIClient.swift`
- `desktop/macos/SidebarStore.swift`
- relevant macOS connection UI and tests
- `scripts/revoke-composio-connections.sh`

## Source references

- Composio connected-account lifecycle: https://docs.composio.dev/reference/api-reference/connected-accounts
- Revoke response behavior: https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsByNanoidRevoke
- Scoped API-key permission for revoke: https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions
