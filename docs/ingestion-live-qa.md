# Connected ingestion live QA

Teams and OneDrive ingestion are implemented, enabled, and covered by the
orchestrator test suite. This document tracks only the remaining provider QA
that cannot be completed with a personal Microsoft account.

Never capture message bodies, file contents, signed download URLs, access
tokens, page tokens, or raw provider responses while performing this QA.

## Microsoft Teams

Status: fixture-tested; a personal/free account confirmed that Microsoft Graph
rejects the required chat and team reads without a Microsoft 365 license.

Required account: a licensed Microsoft 365 work/school tenant, preferably with
an administrator available to observe the consent flow.

Verify:

- Composio managed OAuth requests only the read scopes required by the current
  `microsoft_teams` tools. In particular, record whether channel access requires
  tenant-admin consent for `ChannelMessage.Read.All`.
- App memory reports a visible error rather than a healthy empty source when a
  required scope or admin consent is missing.
- Initial enablement imports only the previous 24 hours from a one-to-one chat,
  group or meeting chat, standard channel, and channel reply.
- Private or shared channels are ingested when the connected user can access
  them; any provider limitation is reported rather than silently skipped.
- Mentions and HTML formatting normalize correctly, while bot, system, deleted,
  and empty messages are excluded.
- A second poll creates no duplicates; new messages and replies appear on the
  next poll; restarting during pagination resumes without skips.
- Disconnecting the Composio account stops polling and revokes/deletes the
  connection through the normal disconnect path.
- Logs and diagnostics contain only sanitized errors and counts.

Implementation and fixtures:

- `desktop/orchestrator/src/memory/ingestion/sources/teams-source.ts`
- `desktop/orchestrator/test/teams-source.test.ts`

## OneDrive

Status: enabled and live-QA'd against a personal OneDrive account. Primary
delta enumeration, over-returned continuation pages, Word download/conversion,
no-change polling, and the personal-account unsupported shared-search response
have been verified.

Required account: a Microsoft 365 work/school account with a supported file
shared from another user.

Verify:

- Composio managed OAuth grants the expected read-only scopes without custom
  Azure credentials.
- The shared-with-me scan lists and downloads supported `.txt`, `.md`, `.doc`,
  and `.docx` files accessible to the connected user.
- SharePoint-site shares remain an explicit provider limitation unless the
  current tool contract supports them.
- The first sync excludes files older than 30 days, while a later edit updates
  the existing memory document instead of creating a duplicate.
- Shared pagination resumes correctly and direct/shared identities remain
  drive-qualified.
- An unreadable file produces metadata-only content without blocking the rest
  of the page.
- Logs contain neither document content nor signed download URLs.

Implementation and fixtures:

- `desktop/orchestrator/src/memory/ingestion/sources/onedrive-source.ts`
- `desktop/orchestrator/test/onedrive-source.test.ts`
