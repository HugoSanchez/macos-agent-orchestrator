# Connected apps

Verso keeps the same desktop and memory engine for managed and local builds.
The selected connection provider determines how connected-app requests travel.

| Input | Request path | Verso account needed? |
| --- | --- | --- |
| Managed connected apps | Desktop → Verso backend → Composio → app | Yes |
| User-owned connected apps (`local` or `byo` mode) | Desktop → your Composio project → app | No |

`byo` uses the same project settings as `local`; it does not enable a custom
Verso backend URL. Source builds default to `local`. Managed builds continue
to use the managed service and do not load a local project key.

## Set up a user-owned project

1. Create a Composio project in your own account and obtain its project API key.
2. In a local build, open **Settings → Connected apps**, paste the key, and
   choose **Verify & save**. Verification makes a read-only connection-list
   request; it does not connect an app.
3. Quit and reopen Verso. Connect apps from the sidebar using the usual browser
   authorization flow. Each project must support the toolkits you choose.
4. Open **Settings → App memory** and enable the connected sources to ingest.

Verso generates a stable Composio user ID for the local profile and displays it
in settings. Connections must belong to that ID; connections created under an
unrelated ID in the dashboard do not automatically appear in Verso.

The project key is stored in macOS Keychain. The profile stores its user ID and
a credential fingerprint, not the key. The key is held by the sidecar, is not
returned by the settings API, and is not placed in the Hermes environment.
This is not a security boundary against arbitrary code running as the same
macOS user. Use a project dedicated to this installation.

Composio remains a cloud dependency and handles connected-app content. Its
project permissions, retention settings, and charges apply. Memory persistence,
normalization, and indexing remain local. Using retrieved memories in an agent
conversation sends relevant content to the configured model provider.

## Change or remove a key

A different key pauses connected apps until restart. Each credential gets a
separate connection cache, tool-usage database, and ingestion ledger. On the
next launch, reconnect as needed and enable the memory sources again. This also
applies to a key rotation within the same Composio project, because a project’s
identity cannot safely be inferred from its key.

Documents from distinct credentials receive distinct source references. Old
memories remain searchable; switching projects does not overwrite them. A key
rotation can therefore produce additional copies of previously ingested content.
Returning to an earlier key reuses its prior ledger. No automatic migration
between the managed profile and a local profile is performed.

**Remove key** disables new requests immediately and rejects results from calls
still awaiting Composio. It cannot cancel effects already accepted upstream.
Removing a key does not remotely revoke connected accounts or erase memories.
Disconnect individual apps before removing the key if you also want to revoke
access; follow any manual revocation notice shown by the app.

If Keychain is unavailable or its key does not match the stored fingerprint,
connected apps remain disabled. Local memory remains usable. Open settings and
save the correct key again, then restart. A Composio outage does not remove
existing memories or reset committed ingestion cursors.

## Implementation and development

`ConnectedAppsProvider` covers connection creation, polling, listing, revocation,
tool discovery, schema lookup, and execution. `create-runtime.ts` selects the
managed HTTP implementation or the user-owned implementation and injects it into
`ConnectionsService` and `ComposioBridgeService`. Both retain the existing
reviewed-send policy. The reusable SDK integration lives in `packages/composio`.

The seven existing app-ingestion adapters still use Composio tool names and
payloads. Their `SourceAdapter` boundary supplies normalized documents and
cursors to the scheduler. A future direct Gmail or other native adapter should
implement that boundary; an arbitrary MCP tool server is not automatically an
ingestion provider. Both connection providers still use Composio for connected-app
ingestion; this change does not add a Composio-independent app adapter.

The settings endpoints use the existing authenticated loopback router:
`GET/PUT/DELETE /settings/composio`. They are not public
OAuth callback routes.

Both backend and orchestrator use a local npm dependency with `install-links=true`.
Run `npm ci` in `server/backend` and `desktop/orchestrator` after editing
`packages/composio`, since npm installs
a packed snapshot. Backend builds/deployments need the full repository layout,
including `packages/composio`, available when installing dependencies. Desktop
packaging stages that layout temporarily and ships a standalone dependency tree;
the shared source does not need to exist outside the installed app.
See [server deployment paths](../server/README.md#deployment) for the hosting
working directories and commands.

Automated tests exercise the shared broker, project isolation, key lifecycle,
loopback authentication and connection/ingestion flow using fake
upstream services. Before distributing this feature, also exercise connection,
ingestion, a reviewed tool action, and revocation with a real personal Composio
project in a local macOS build. Automated tests do not verify external OAuth
configuration or provider permissions.
