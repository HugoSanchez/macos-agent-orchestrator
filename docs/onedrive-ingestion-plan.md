# OneDrive ingestion implementation plan

Status: approved, implemented, and live-QA'd against a personal OneDrive account; work/school shared-item QA pending  
Prepared: 2026-08-27  
Scope: Composio-backed passive memory ingestion  
Parity target: the existing Google Drive source

## Objective

Add `OneDriveSource` to the existing ingestion scheduler. A user who connects Composio's `one_drive` toolkit should see OneDrive under Settings → App memory and be able to enable passive ingestion without configuring Azure credentials.

Parity means the same product behavior as Google Drive: a 30-day first-sync window, batches of at most five, shared-file coverage where the provider supports it, document updates replacing the prior memory document, header-only fallback when content cannot be read, and no write operations. OneDrive's equivalent content scope is Word documents plus plain-text and Markdown files.

## Provider contract

Use the current Composio `one_drive` toolkit version `20260817_00`:

- `ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES` for the primary drive's initial enumeration and durable delta polling.
- `ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS` for a separately resumable shared-with-me snapshot.
- `ONE_DRIVE_DOWNLOAD_FILE` for original file bytes.

The authenticated input schemas, finite response paths, scope limitation, and download contract are frozen in `.context/onedrive-tool-contract.md`. The tools are current and read-only. Composio advertises managed OAuth, preserving the existing one-click connection flow.

## Adapter and release gate

Add:

- `desktop/orchestrator/src/http/onedrive-source.ts`
- `desktop/orchestrator/test/onedrive-source.test.ts`

Register `new OneDriveSource(composioBridge)` beside `GdriveSource`. Use source slug `onedrive`, display name `OneDrive`, logo slug `one_drive`, and map `onedrive` to toolkit `one_drive` in `SOURCE_TOOLKITS`.

Registration is gated by `VERSO_ONEDRIVE_INGESTION_ENABLED`, defaulting to false. The flag is removed only after live OAuth, scope, payload, download, and Word-conversion QA. Once enabled, no bespoke UI is needed: App memory already filters to connected sources and ingestion remains opt-in per user.

## Cursor and polling state machine

Persist a bounded versioned cursor:

```ts
interface OneDriveCursor {
  v: 1;
  phase: 'primary' | 'shared';
  token: string | null;
  floor: string;
  initial: boolean;
  resync: boolean;
  sharedFrom: number;
  consumedPageIds: string[];
}
```

`seedCursor(now, lookbackMs)` starts the primary phase with a 30-day floor, no token, `initial: true`, `resync: false`, and `sharedFrom: 0`.

Primary phase:

- Request `top: 5` and pass a stored next/delta URL back unchanged. Graph may still return a larger continuation page; drain it across bounded batches by persisting consumed item keys and re-fetching the same page until every raw record is accounted for.
- Persist `@odata.nextLink` and keep `hasMore: true` while draining pages.
- On the terminal page, require `@odata.deltaLink`, persist it, switch to `phase: 'shared'`, reset `sharedFrom`, and keep `hasMore: true` so the same sync run covers shared files. Keep `initial: true` until that first shared snapshot also completes.
- Apply the 30-day floor to both primary and shared items while `initial && !resync`. Incremental cycles ingest all supported changes.
- On explicit HTTP 410, `syncStateNotFound`, or `resyncRequired`, reset the primary token, set `resync: true`, and immediately retry from a fresh enumeration. A recovery enumeration and its following shared snapshot do **not** reapply the original 30-day floor: the scheduler dedup ledger absorbs already-seen versions.
- Other errors do not advance the cursor.

Shared phase:

- Request `size: 5` at `sharedFrom` and advance the offset by the raw result count.
- Continue while at least five raw results are returned. When fewer than five are returned, reset the offset, switch to `phase: 'primary'`, retain the durable delta token, set `initial: false` and `resync: false`, and return `hasMore: false`.
- This snapshot may revisit unchanged files; the scheduler ledger suppresses unchanged `dedupRef`s.
- Microsoft Search rejects this shared snapshot for personal Microsoft (`MSA`) accounts. Treat that exact provider limitation as an empty shared phase so primary-drive ingestion still completes. Work/school accounts continue through the shared scan.
- The provider also excludes SharePoint-site shares. These are documented parity limits rather than silently claiming full Microsoft 365 coverage.

Parser constraints:

- Reject non-v1, malformed, or oversized non-empty cursors instead of silently restarting.
- Cap serialized cursor size at 64 KiB, provider tokens at 16 KiB, and `sharedFrom` at a safe non-negative integer bound.
- Accept only the response paths frozen in the tool contract. Require a recognized item array and the appropriate continuation shape.
- Provider pages are capped at 500 raw records. Pages larger than the requested five are replayed using bounded `consumedPageIds`; each ingestion batch still emits at most `maxItemsPerBatch = 5`. Pages above the hard cap fail closed.

## File selection and identity

Accept `.txt`, `.md`, `.markdown`, `.doc`, and `.docx`, plus their standard text/Markdown/Word MIME types. Reject PDFs, spreadsheets, presentations, images, folders, packages, unknown binaries, root records, and deleted items. Deletion propagation remains out of scope, matching Google Drive.

Require both the DriveItem ID and `parentReference.driveId`, including for shared files. The composite identity prevents collisions across drives:

```ts
const sourceRef = `${driveId}:${item.id}`;
const version = item.eTag || item.cTag || item.lastModifiedDateTime;

{
  sourceRef,
  dedupRef: `${sourceRef}:${version}`,
  cursorValue: Date.parse(item.lastModifiedDateTime),
  occurredAt: normalizedLastModifiedDateTime,
  title: item.name,
  content: `Document: ...\nModified: ...\nLink: ...\n\n<body>`
}
```

Sort returned items chronologically. Malformed IDs, drive IDs, versions, or timestamps are skipped without exposing provider payloads.

## Content download and conversion

- Call `ONE_DRIVE_DOWNLOAD_FILE` with `item_id`, `file_name`, `user_id: 'me'`, and the item `drive_id`.
- Pass `{ recordUsage: false }` to all list and download calls so background ingestion does not affect interactive tool ranking.
- Extract only an exact HTTPS file path listed in the frozen contract; never recursively accept an arbitrary nested `url`.
- Use an injected byte fetcher with a 30-second timeout, successful-status check, explicit HTTP(S) redirect policy, `Content-Length` precheck, and streaming 10 MiB hard cap. Reuse `MAX_DOCUMENT_BYTES`.
- Decode text/Markdown as UTF-8 and strip a BOM.
- Reuse `convertDocumentToMarkdown` for Word bytes; do not add another document parser.
- Cap assembled memory content at the same 40,000 characters as Google Drive.
- If one file's download, URL fetch, or Word conversion fails, emit its metadata header only and continue. Sanitize warnings; never log URLs, file contents, auth data, or provider response bodies.
- A listing or cursor failure rejects the batch so the scheduler retries without committing the proposed cursor.

## Tests

Use an injected fake bridge, byte fetcher, and document converter. Cover:

1. The seed cursor uses the 30-day lookback and strict bounded parsing rejects malformed cursors.
2. Initial primary pagination persists a next link, filters items older than the floor, and obtains a durable delta link.
3. Incremental polling passes the complete stored delta URL with `top`/`select` and ingests changed files regardless of the floor.
4. Explicit expired-token signals reset into a full recovery enumeration and shared snapshot; recovered items are not filtered by the original floor.
5. Unrelated errors and malformed page envelopes do not advance the cursor.
6. The shared phase resumes by offset, applies the floor during the first cycle (including an old shared-file fixture), returns to primary after completion, and only then clears `initial`.
7. An old shared file filtered on first sync is eligible when it reappears during a recovery snapshot.
8. Primary and shared files use `${driveId}:${itemId}` identities and stable versioned dedup refs.
9. Folders, deleted entries, unsupported types, malformed identities, and invalid timestamps are skipped.
10. Text/Markdown decode directly and Word files use the injected converter.
11. Downloads pass `drive_id`; content or conversion failures produce header-only items without blocking the page.
12. Only the frozen download URL paths are accepted; arbitrary nested URLs and non-HTTP(S) schemes are rejected.
13. The byte fetcher enforces timeout, status, redirect protocol, `Content-Length`, and streaming 10 MiB limits.
14. Provider over-return is replayed across five-item batches without skipping records; pages above the hard provider cap fail closed.
15. Every Composio call uses `{ recordUsage: false }`.
16. Registration stays absent by default and appears only when `VERSO_ONEDRIVE_INGESTION_ENABLED=true`.

Run the focused OneDrive tests and orchestrator typecheck during implementation. Run the full orchestrator suite before handoff because registration and shared ingestion types are touched.

## Live QA before enabling

Completed on 2026-08-27 against a connected personal Microsoft account:

- OAuth reached an active account and a real delta read succeeded.
- Initial enumeration completed despite live continuation pages of seven records when `top: 5` was requested.
- One recent `.docx` was downloaded from the verified `content.s3url` envelope and converted to non-empty body text locally.
- The durable delta cursor completed a second no-change cycle with zero duplicate items.
- Personal-account shared search returned Microsoft's documented-in-payload MSA unsupported error and completed as an empty shared phase.

Still required before enabling for everyone: inspect the granted consent scopes and run the shared scan/download path with a work/school account.

Use one connected personal or work/school OneDrive account containing:

- recent `.txt`/`.md` and `.docx` files;
- one supported file older than 30 days;
- one supported file shared from another personal OneDrive account;
- one edited file after the first completed sync.

Verify OAuth returns to Verso; inspect the granted scopes; confirm the finite primary/shared/download response paths; confirm direct and shared downloads; confirm the first sync includes only recent supported files; and confirm an edit updates rather than duplicates its memory document. Capture only sanitized response shapes if the envelope differs from the contract—never file contents or signed URLs.

## Acceptance criteria

- The implementation compiles and passes focused/full orchestrator tests while remaining unavailable under the default release flag.
- When explicitly enabled, a connected OneDrive account receives the standard App memory toggle with no Azure setup.
- The primary drive uses durable delta polling; explicit token expiry safely re-enumerates without dropping older current files.
- Work/school shared-with-me files have a separate resumable scan. Personal-account Microsoft Search and SharePoint-site shares remain explicitly out of scope.
- Every batch is capped at five and every identity is drive-qualified.
- Word/text content is processed locally after a bounded download; no third-party parser or new credential path is introduced.
- Background calls remain read-only and do not affect tool ranking.
- One unreadable file cannot poison the source; listing/cursor failures remain visible and retryable.
