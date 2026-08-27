# Microsoft Teams ingestion implementation plan

Status: implemented and enabled for all users; licensed work/school live QA pending  
Prepared: 2026-08-27  
Scope: Composio-backed passive memory ingestion  
Parity target: the existing Slack ingestion source

## Objective

Add a custom `TeamsSource` adapter to Verso's existing ingestion pipeline. When a user connects the `microsoft_teams` Composio toolkit and enables ingestion, Verso should ingest the same categories of communication that the current Slack source ingests: human-authored messages from channels, one-to-one chats, and group chats.

The implementation must reuse the existing scheduler, ingestion ledger, retry behavior, source toggle, memory provider, and connection gate. It must not introduce a recipe engine, a second scheduler, direct Microsoft Graph credentials, or model-driven ingestion.

Implementation was completed and fixture-tested without a licensed Microsoft 365 account. A personal/free account confirmed that the Graph chat and team APIs reject unlicensed accounts. Licensed tenant validation remains pending; see **Microsoft consent and live QA**.

## Existing behavior that defines parity

The canonical reference is `desktop/orchestrator/src/http/slack-source.ts`, together with its user and conversation directories and tests.

| Slack behavior today | Required Teams equivalent |
| --- | --- |
| One ingestion source and one scheduler stream | Source `teams`, stream `''` |
| Connection gate uses toolkit `slack` | Map source `teams` to toolkit `microsoft_teams` |
| Initial lookback is 24 hours | Initial lookback is 24 hours |
| Searches all accessible channels and DMs | Enumerate all chats and channels available to the connected user |
| Includes channel, one-to-one DM, and group-DM messages | Include team-channel, one-to-one chat, and group/meeting-chat messages |
| Skips bot/system messages and empty content | Accept only human-authored `message` records with non-empty normalized body |
| Resolves authors and mentions to display names | Use Graph `from.user.displayName` and `mentions[].mentioned.user.displayName`/`mentionText`, with safe fallbacks |
| Labels channels, DMs, and group DMs | Label team/channel, one-to-one chat peer, and group/meeting chat |
| Groups messages into one memory document per conversation per day | Same grouping for each Teams chat or channel |
| Each message has a unique dedup key | Dedup by conversation-qualified message ID |
| Durable cursor drains pagination without skips | Durable Teams state machine resumes discovery and message pagination without skips |
| Bounds extraction batch and content size | Default scheduler batch and 4,000-character per-message limit |
| Provider calls do not affect interactive tool ranking | Every ingestion call uses `{ recordUsage: false }` |
| Enrichment failure never breaks ingestion | Missing member/topic/display-name data falls back to stable generic labels |

### Explicit non-goals

These are not part of Slack parity and must not be added to the first Teams implementation:

- Meeting transcripts or recordings.
- Files and attachments.
- Reactions.
- Re-indexing edits to messages that were already ingested.
- Propagating deletions into passive memory.
- Sending messages or any other mutating Teams operation.
- Organization-wide export APIs or application permissions.
- Webhooks/change notifications.
- Teams outside the connected user's accessible delegated scope.
- SharePoint or OneDrive content.

## API and authentication facts

Use current, non-deprecated Composio tool slugs from the latest `microsoft_teams` toolkit version. Do not use the deprecated `MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES`, `MICROSOFT_TEAMS_TEAMS_LIST_CHAT_MESSAGES`, `MICROSOFT_TEAMS_LIST_CHAT`, or stale v3 aliases.

Candidate read-only tools to validate against the latest Composio schemas before writing call arguments:

- `MICROSOFT_TEAMS_GET_MY_PROFILE`
- `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`
- `MICROSOFT_TEAMS_LIST_USER_CHAT_MEMBERS`
- `MICROSOFT_TEAMS_LIST_USER_CHAT_MESSAGES`
- `MICROSOFT_TEAMS_LIST_USER_JOINED_TEAMS`
- `MICROSOFT_TEAMS_LIST_ASSOCIATED_TEAMS`, if required to discover directly accessible shared channels
- `MICROSOFT_TEAMS_LIST_INCOMING_CHANNELS`, if required to discover channels shared into a joined team
- `MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS`
- `MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES`
- `MICROSOFT_TEAMS_LIST_MESSAGE_REPLIES`, only if the channel-list tool cannot expand replies

### Step 0 go/no-go: freeze the provider contract

Before implementation code begins, save the current input schemas and descriptions for these tools in `.context/teams-tool-schemas.json` using an authenticated Composio development key. This file is diagnostic context and must not be committed. The backend's direct catalog path already requests `toolkit_versions=latest`; schema inspection must do the same.

Turn those schemas into `.context/teams-tool-contract.md`, with one row per selected tool:

| Contract field | Required evidence |
| --- | --- |
| Exact current slug and toolkit version | Latest Composio schema response |
| Purpose and required arguments | Schema, including whether the user identifier is `me`, GUID, or UPN |
| Response item path(s) | Concrete sanitized fixture envelope |
| Pagination request/response fields | Exact page-token argument and response path |
| Maximum page size | Schema/provider documentation |
| Ordering and supported time filters | Exact arguments and semantics |
| Channel reply behavior | Whether expansion exists, its maximum, and how overflow pagination is exposed |
| Required delegated scopes | Latest versioned Composio scope response |

This contract is a go/no-go gate. Do not guess core arguments, pagination, ordering, filter, reply, or response-envelope behavior in implementation code. If the current tools cannot express a complete chronological drain, stop and revise the design before coding. Record the exact toolkit version used by fixture assumptions in test comments.

Do not use `MICROSOFT_TEAMS_SEARCH_MESSAGES` as the ingestion stream. Microsoft Search ranks Teams results by relevance, does not support sorting, returns at most 25 message results per page, and does not return every `chatMessage` property. It cannot provide a trustworthy chronological watermark and could reorder pages as the index changes.

### Required delegated permissions

Validate the exact scopes returned by Composio's latest-version scope endpoint for every selected tool. The expected Microsoft Graph minimums are:

- Chats and chat messages: `Chat.Read` (no tenant-admin consent required).
- Joined teams: `Team.ReadBasic.All` (no tenant-admin consent required).
- Channel names: `Channel.ReadBasic.All` (no tenant-admin consent required).
- Channel messages and replies: `ChannelMessage.Read.All` (tenant-admin consent required).
- Basic signed-in profile: `User.Read` or the scope selected by the current profile tool.

No write scopes are needed for ingestion. If Composio reports a write scope for a selected read tool, investigate a newer replacement slug before accepting it.

## Microsoft consent and live QA

Full Slack parity includes channel messages. Microsoft marks delegated `ChannelMessage.Read.All` as requiring tenant-admin consent. Composio also warns that stale Teams tool metadata can surface the invalid delegated scope `ChannelMessage.Read.Group`; the latest v3.1 replacement tools must be used instead.

Consequences:

1. A normal user may be able to authorize chat ingestion but be unable to authorize channel ingestion without their tenant administrator.
2. The implementation must not silently present a healthy source while ingesting chats only.
3. Confirm that Composio's managed Teams app requests the expected latest scopes and observe the real consent UX in at least one licensed Microsoft 365 tenant as soon as one is available.
4. A personal/free Teams account can complete connection but Microsoft Graph rejects the required chat/team reads with `Invoked API requires a valid license`. This does not validate the licensed work/school path.

Product decision (2026-08-27): register Teams for every user before licensed live QA. Keep the parity target intact and treat licensed tenant QA as a high-priority follow-up.

## Proposed architecture

### 1. Source and helpers

Add:

- `desktop/orchestrator/src/http/teams-source.ts`
- `desktop/orchestrator/test/teams-source.test.ts`

Keep response normalization, cursor parsing, target discovery, HTML-to-text conversion, and name fallbacks in `teams-source.ts` until the file becomes difficult to reason about. Split only clear, independently testable helpers such as a directory into `teams-users.ts` or `teams-conversations.ts` if the final implementation justifies it.

The adapter implements the existing `SourceAdapter` interface:

```ts
export class TeamsSource implements SourceAdapter {
  readonly source = 'teams';
  readonly displayName = 'Microsoft Teams';
  readonly logoUrl = 'https://logos.composio.dev/api/microsoft_teams';
  readonly defaultStream = '';
  readonly seedLookbackMs = 24 * 60 * 60 * 1000;
}
```

Use the scheduler's normal `maxItems` default. Limit each normalized message to 4,000 characters, matching Slack.

### 2. Server registration

Update `desktop/orchestrator/src/http/server.ts`:

- Instantiate `new TeamsSource(composioBridge)` with the existing adapters.
- Add `teams: 'microsoft_teams'` to `SOURCE_TOOLKITS` so the local connection gate recognizes the Composio connection.

No ingestion routes, store schema, memory-provider API, or macOS UI changes should be necessary. The existing source list is adapter-driven, so registration should make the standard connected/enabled/status/count view appear automatically.

### 3. Do not use a single timestamp-only cursor

Teams cannot safely mirror Slack's single search cursor:

- Chats and channels are separate collections.
- Each collection paginates separately.
- Chat messages can be filtered by `lastModifiedDateTime`, but channel message listing has more limited filtering.
- Channel roots and replies are separate unless replies can be expanded.
- Stopping after `maxItems` while advancing a global watermark would skip messages in targets not yet visited.

Use a versioned, resumable discovery-and-drain cursor. A representative shape is:

```ts
interface TeamsCursorV1 {
  v: 1;
  /** Fully committed lower bound from the previous completed cycle. */
  watermark: string;
  /** False for the initial 24-hour backfill; true after its first complete drain. */
  hasCompletedCycle: boolean;
  /** Fixed upper bound captured at the start of this cycle. */
  upperBound: string | null;
  phase: 'idle' | 'discover_chats' | 'discover_teams' | 'discover_channels' | 'drain';
  discoveryPageToken: string | null;
  teams: Array<{ id: string; name: string }>;
  teamIndex: number;
  targets: TeamsTarget[];
  targetIndex: number;
  drainStage: 'messages' | 'channel_roots' | 'channel_replies';
  /** Token used to request the current provider page; it does not advance mid-page. */
  pageRequestToken: string | null;
  /** Token advertised for the following page. */
  nextPageToken: string | null;
  /** IDs already emitted from a provider page that must be safely re-fetched. */
  consumedPageIds: string[];
  channelPage: {
    rootIds: string[];
    rootIndex: number;
    nextRootPageToken: string | null;
  } | null;
  replyRootId: string | null;
  replyPageToken: string | null;
}

type TeamsTarget =
  | { kind: 'chat'; id: string; label: string; enrichmentDone: boolean }
  | { kind: 'channel'; id: string; teamId: string; label: string };
```

The exact field names may change during implementation, but the following invariants may not:

1. `watermark` advances only after every target in a completed discovery snapshot has been drained. It is the last completed-cycle boundary, not an absolute dedup floor.
2. `upperBound` is captured once when an idle cycle starts and remains fixed until that cycle completes.
3. Discovery pagination, team/channel enumeration, target index, and message page token are durable.
4. Reaching the adapter's item or call budget returns `hasMore: true` and a cursor that resumes exactly where the previous call stopped.
5. On full completion, commit `watermark = upperBound`, clear transient target state, and return `hasMore: false`.
6. Messages created after `upperBound` may be seen during the drain, but must not cause the committed watermark to advance beyond `upperBound`; scheduler dedup absorbs their next-cycle reappearance.
7. Malformed, empty, system, and bot records do not prevent cursor progress.
8. After the initial cycle, every cycle queries a 24-hour replay window: `replayFloor = watermark - 24 hours`. Local acceptance uses `(replayFloor, upperBound]`, and the existing `dedupRef` ledger absorbs already processed messages. This recovers chats, channels, and messages that become visible after a cycle covering their timestamp.
9. The initial cycle does not subtract the replay window twice: `seedCursor` sets `hasCompletedCycle: false`, and that cycle uses its seeded 24-hour watermark directly as `replayFloor`.
10. A provider page token advances only after the whole current page, including relevant channel replies, has been processed. Scheduler dedup is not an in-page progress mechanism.

The cursor parser must tolerate an empty or legacy numeric/ISO cursor by converting it into an idle v1 cursor with `hasCompletedCycle: false`. Reject nonsensical future watermarks by falling back to the configured lookback floor rather than permanently starving the source.

### Page-atomic progress

The existing scheduler deduplicates only after `fetchSince` returns. Therefore, re-fetching a 50-message page and repeatedly returning its first 20 items can loop forever even though the scheduler discards those duplicates.

The adapter must obey these rules:

- Request no more than the remaining item allowance when the provider honors page size and every response entity maps to at most one item.
- Fully consume a returned page before advancing to its `nextPageToken`.
- If a provider ignores page size or a page can expand into more items than the remaining allowance, persist the current request token plus the bounded set of message IDs already consumed from that page. Re-fetch that same page and select unconsumed IDs; do not use a numeric offset that can shift under insertion or reordering.
- Never rely on the ingestion ledger to progress within a provider page.
- Expanded channel replies may be used only if the reply collection is provably bounded by the remaining allowance or exposes a resumable overflow token. Otherwise drain replies through their dedicated paginated tool and explicit reply substate.

### 4. Bound tool calls as well as items

Discovery can otherwise produce an unbounded N+1 request fan-out. Add an adapter-local tool-call budget, initially 20 Composio executions per `fetchSince` call. Every profile, list, member, message, channel, and reply call counts toward it.

When the call budget is exhausted:

- Persist the current phase/index/page token.
- Return the items collected so far.
- Return `hasMore: true` so the scheduler schedules another drain tick immediately.

Also enforce defensive structural limits:

- Maximum 1,000 targets in one discovery snapshot.
- Maximum 500 teams.
- Maximum 500 channels for a single team.
- Maximum consumed-ID entries equal to the validated provider page maximum.
- Maximum opaque page-token length, e.g. 16 KiB.
- Maximum serialized cursor size, e.g. 1 MiB.

Exceeding a structural limit must fail the source with a sanitized explanatory error. It must not silently commit the watermark over omitted targets.

### 5. Discovery state machine

At the start of a cycle:

1. Set `upperBound` to the current ISO timestamp and compute `replayFloor`: the seeded watermark for the initial cycle, otherwise 24 hours before the last completed watermark.
2. Best-effort resolve and cache the signed-in user's Graph ID/profile using `GET_MY_PROFILE`; the modern chat-message tool may require a GUID or UPN rather than `me`.
3. List every chat with the supported page size and follow Composio's opaque page token.
4. Request `members` and `lastMessagePreview` expansion through the chat-list tool if its frozen contract supports it.
5. Build chat targets:
   - one-to-one: `Chat with <peer display name>` when member data is available;
   - group: topic, then member-name summary, then `Group chat`;
   - meeting chat: topic, then `Meeting chat`.
6. List the user's joined teams and follow every page exposed by the frozen Composio contract.
7. Include associated teams and incoming/shared channels through the validated replacement tools when needed. Microsoft documents that `joinedTeams` alone omits host teams for some directly accessible shared channels. If the current delegated Composio surface cannot enumerate these safely, the Step 0 gate must record that parity gap and stop implementation pending a product decision.
8. For each team, list all accessible standard/private/shared channels returned to the delegated user and build channel targets labeled `<team name> · #<channel name>`.
9. Deduplicate targets by `kind + teamId/chatId + channelId` before entering `drain`.

Member/name enrichment is best effort. Do not add an untracked per-chat enrichment loop during discovery. Use expanded member data when it is present. If the frozen contract requires a separate member call, perform it lazily for the current chat target before draining messages, persist the resolved/fallback label and `enrichmentDone: true`, and return `hasMore: true` if that call exhausts the budget. A failed member call uses `One-to-one chat`, `Group chat`, or `Meeting chat` and still marks enrichment complete. Team/channel discovery and message reads are core operations and must fail/retry rather than silently omit an inaccessible page.

The response envelope and pagination extractor should tolerate documented Composio/Graph variants such as `value`, `data`, `chats`, `teams`, `channels`, `messages`, `next_page_token`, `nextPageToken`, and `@odata.nextLink`, while accepting only validated object arrays and bounded strings.

### 6. Message drain

For each chat target:

- Call the current non-deprecated user-chat-message tool.
- Request at most both the provider maximum page size and the remaining item allowance (Microsoft Graph currently caps chat messages at 50). If the frozen contract shows that Composio can return more anyway, use the consumed-ID page state described above.
- When supported by the frozen contract, order by `lastModifiedDateTime desc` and filter `lastModifiedDateTime gt replayFloor and lastModifiedDateTime lt upperBound`.
- Follow the returned page token until the provider is exhausted or the adapter budget is reached.
- Accept only messages whose `createdDateTime` is in `(replayFloor, upperBound]`. Using `lastModifiedDateTime` for retrieval catches new messages while local filtering plus stable dedup prevents old edits/reactions from becoming duplicate memory lines.

For each channel target:

- List root messages newest-first, requesting expanded replies if supported.
- Microsoft sorts channel roots by the last modification time of the entire reply chain. Continue until a page proves that every remaining root/reply chain is at or before `replayFloor`.
- Include roots and replies created within `(replayFloor, upperBound]`.
- If the Composio channel-list tool cannot expand all replies, call the current reply-list tool for roots whose chain was modified after `replayFloor`, following its pagination. These calls count against the same budget.
- Persist the fetched root IDs and the following root-page token until every relevant root's replies are exhausted. Exhausting the call budget after listing roots but before listing replies must resume those replies; it must not advance the root-page token.
- Persist `replyRootId` and `replyPageToken` while a root's replies are being drained. A channel target is exhausted only after its root pages and every relevant reply page are exhausted.
- Do not advance past a partially drained provider page. Use page-atomic sizing or the explicit request-token/consumed-ID state; a bare `nextPageToken` is insufficient.

If the concrete Composio schemas cannot express the required time filters, ordering, page tokens, or reply expansion, update the cursor with whatever additional per-target resume state is necessary. Do not substitute relevance-ranked search or silently cap pages.

### 7. Normalize Teams messages into Slack-compatible documents

Accept a record only when:

- It has a non-empty message ID.
- It has a valid `createdDateTime`.
- `messageType` is `message` or absent in a payload otherwise shaped like a normal human message.
- `from.user` is present; skip application/bot/device/system senders for Slack parity.
- Its normalized body is non-empty.

Generate:

```ts
{
  sourceRef: `${targetKey}#${YYYY_MM_DD}`,
  dedupRef: `${targetKey}:${messageId}`,
  cursorValue: Date.parse(createdDateTime),
  occurredAt: normalizedCreatedDateTime,
  title: `${target.label} ${YYYY_MM_DD}`,
  content: `[HH:mm] ${author}: ${text}`,
  merge: true,
}
```

`targetKey` must include the container because Microsoft documents that message IDs are unique within a chat/channel/reply context, not globally. Use explicit prefixes so a chat and channel cannot collide, for example `chat:<chatId>` and `channel:<teamId>:<channelId>`.

For a channel reply, use the reply's own message ID. If a provider payload can reuse a reply ID under different roots, include the root ID in `dedupRef` as well.

Sort accepted items by `cursorValue`, with `dedupRef` as a stable tiebreaker, before returning them.

### 8. HTML and mention normalization

Teams bodies are commonly HTML. Add a small deterministic normalizer rather than indexing markup:

1. Replace `<at id="n">...</at>` with `@<resolved mention name>` using the message's `mentions` collection; fall back to the tag's visible text.
2. Convert `<br>`, paragraph, list-item, and block boundaries to newlines.
3. Remove remaining tags, scripts, styles, and hidden markup.
4. Decode common named and numeric HTML entities.
5. Normalize non-breaking spaces and excessive blank lines/whitespace.
6. Truncate only after the header/author/time line and normalized content are assembled.

The normalizer must not execute HTML, fetch remote resources, or preserve invisible instruction text. Tests must include malformed HTML, mentions, entities, links, code-like text, and a prompt-injection string to prove it remains inert text rather than affecting control flow.

## Failure and retry behavior

- A core discovery/message tool error throws with the tool slug and sanitized bridge error, allowing the scheduler's existing retry/backoff behavior to apply.
- A missing scope or admin-consent error must remain visible in the source's `lastError`; do not reinterpret it as an empty page.
- Profile/member/display-name enrichment is best effort and never throws out of `fetchSince`.
- A `404`/membership loss for a target discovered earlier in the same cycle may skip that target only when the error is unambiguously target-local; record a sanitized warning. Authentication, scope, throttling, network, and server errors must retry the cycle.
- Never log response bodies, message text, member names, tokens, page tokens, or tenant data.
- Every tool call is read-only and passes `{ recordUsage: false }`.
- The adapter must make no direct network calls and must use only the injected `IngestionBridge`.

## Tests

### Unit tests for `TeamsSource`

Use an injected fake `IngestionBridge` and response fixtures. Cover at minimum:

1. `seedCursor` starts 24 hours before `now`.
2. Empty/legacy/versioned cursor parsing.
3. Paginated chat discovery resumes without duplicate targets.
4. Paginated team discovery and per-team channel discovery resume exactly.
5. One-to-one, group, meeting, and channel labels with fallbacks.
6. Chat-message pagination stops at the item budget and resumes the same page safely; a 50-message provider result with `maxItems = 20` drains in three calls without a loop or skip.
7. Channel roots and replies both enter the same channel-day document.
8. A root older than `replayFloor` with a new reply is not skipped.
9. More messages than `maxItems` cannot cause unvisited targets to be skipped.
10. Messages arriving after `upperBound` cannot advance the committed watermark.
11. The first 20 records on a replayed page can already be deduplicated while record 21 is new; adapter progress cannot depend on scheduler dedup.
12. IDs are conversation-qualified and cannot collide across chats/channels.
13. Messages are ordered stably before return.
14. Human authors and mentions use display names.
15. Application, bot, device, system, deleted, empty, malformed, and timestamp-less records are skipped.
16. HTML normalization and entity decoding.
17. The 4,000-character content limit.
18. Every bridge call uses `{ recordUsage: false }`.
19. Enrichment errors fall back without failing ingestion.
20. Core provider/scope errors throw and are sanitized.
21. Twenty-call budget persists the exact resume state and sets `hasMore`.
22. The call budget can expire after fetching channel roots but before their replies, then resume the same roots.
23. The call or item budget can expire midway through paginated replies without advancing the root page.
24. Member enrichment can consume the last available call and resume deterministically with its result/fallback persisted.
25. Structural limits fail rather than silently truncate.
26. A complete cycle clears transient state, commits exactly `upperBound`, and returns `hasMore: false`.
27. Re-running the 24-hour boundary window is safe under scheduler dedup.
28. A chat/channel appearing one cycle late with a message timestamp below the prior `upperBound` is recovered by the replay window.
29. Provider insertion or reordering during discovery/page replay cannot cause numeric-offset skips.

### Scheduler and route integration tests

Extend or add tests proving:

- `teams` appears in `listSources()` after registration.
- `teams` reports connected only for active toolkit slug `microsoft_teams`.
- Enabling a disconnected Teams source returns the existing `409 not_connected` response.
- Enabling seeds the 24-hour cursor.
- Disabling preserves the existing source behavior and stops claims.
- Reset deletes the Teams ledger rows and passive memory source documents through the existing generic route.

Do not add a new database table or route solely for Teams.

### Regression checks

Run:

```bash
cd desktop/orchestrator
npm run typecheck
npm test
```

Also run backend tests if schema lookup, scope inspection, or Composio connection behavior changes. No backend change is expected for the adapter-only implementation.

## Live QA matrix

One real Microsoft 365 account is the minimum release gate; two tenants are preferable.

### Account and consent

- Composio managed Teams OAuth starts from the existing Verso Connect flow.
- No Azure application creation, developer console, API key, or custom credential is required from the user.
- Consent requests only the read scopes required by the chosen tools.
- Observe and document the `ChannelMessage.Read.All` tenant-admin experience.
- Disconnect revokes/deletes the Composio connection and the source stops polling.

### Content coverage

- Standard team channel.
- Private/shared channel when accessible.
- Channel root plus reply.
- One-to-one chat.
- Group chat.
- Meeting chat, as a chat only.
- Mention and HTML formatting.
- Empty/system/bot message exclusion.
- More than one page of messages if feasible.

### Incrementality

- Initial enable imports only the last 24 hours.
- A second poll without new messages creates no duplicates.
- A new message appears after the next poll.
- A new reply to an old channel root appears.
- Restart during a multi-page drain resumes without skips or duplicates.
- A 429 or temporary provider failure backs off and later recovers.

### Privacy and diagnostics

- Message bodies remain in the local memory database and do not appear in logs.
- Source diagnostics expose only sanitized errors and counts.
- Prompt-like text from Teams is indexed as untrusted source content; it never becomes a skill, routine, SOUL instruction, or tool argument during ingestion.

## Implementation sequence

1. Complete the Step 0 schema/scope capture and provider-contract table. This is a go/no-go gate: there may be no unresolved core pagination, ordering, reply, or response-shape assumptions when coding starts.
2. Add cursor types/parser, replay-window logic, page-atomic progress, envelope extractors, and message/HTML normalization with unit tests.
3. Implement bounded chat/team/channel discovery.
4. Implement chat message draining.
5. Implement channel root/reply draining.
6. Add normalization into per-conversation/day `IngestionItem`s.
7. Register `TeamsSource` and add the source-to-toolkit mapping.
8. Add scheduler/route integration coverage.
9. Run full orchestrator checks.
10. Conduct independent reviews for ingestion correctness, Composio/Graph assumptions, security/privacy, and tests.
11. Resolve review findings.
12. Merge as implementation-complete/live-QA-pending unless the Microsoft tenant QA matrix has been completed.
13. Register or enable the public source only after the consent and live-payload gate passes.

## Acceptance criteria

Implementation is complete when:

- Teams is implemented through the existing `SourceAdapter` seam with no parallel ingestion architecture.
- Chats, group chats, team channels, and channel replies satisfy the Slack parity table.
- Discovery and every nested pagination layer resume durably without advancing over unvisited content.
- Partially consumed message/root/reply pages have explicit durable state and cannot loop behind scheduler dedup.
- A 24-hour replay window recovers late-visible targets and messages without changing the initial 24-hour backfill.
- Directly accessible shared-channel discovery is covered by the frozen provider contract or called out as an explicit parity blocker before coding.
- No relevance-ranked search is used as a cursor.
- No write-capable Teams tool is called.
- Tool-call, target, token, cursor, item, and content limits are enforced.
- Provider and missing-scope failures are visible rather than converted into empty success.
- Unit and integration tests cover the state-machine boundaries above.
- Typecheck and the full orchestrator suite pass.
- The implementation has received independent multi-agent review.
- The Step 0 tool contract contains exact latest-version slugs, arguments, envelopes, pagination, page limits, ordering/filter support, reply semantics, and delegated scopes.

Public-release enablement additionally requires:

- A real Composio managed OAuth flow with no user-created Azure credentials.
- Confirmation of the actual latest scopes and channel admin-consent behavior.
- At least one successful live backfill and incremental poll across chat and channel content.

## Independent plan review record

Claude Code Fable 5 reviewed the completed first draft on 2026-08-27 against the current Slack adapter and generic scheduler. Its findings were incorporated as follows:

- **Blocker — partial provider pages could loop behind scheduler dedup:** added page-atomic sizing plus explicit request-token, consumed-ID, channel-root, and reply-page state.
- **Blocker — a strict completed watermark could miss late-visible Microsoft data:** added a 24-hour replay window while retaining a 24-hour initial backfill.
- **Blocker — implementers would still have to guess the provider contract:** made an authenticated latest-version schema/scope contract a Step 0 go/no-go gate.
- **High — per-chat member enrichment was not resumable:** changed it to expanded-member data or lazy per-target enrichment with a persisted completion flag.
- **High — channel root pagination could advance before replies completed:** required durable root-page and reply-page substate and added budget-boundary tests.

The review also requested explicit tests for page sizes larger than `maxItems`, deduped prefixes, late-visible targets, insertion/reordering, budget exhaustion before replies, paginated replies, and enrichment at the call boundary; all are now included above.

## Primary references

- Composio Microsoft Teams toolkit: https://docs.composio.dev/toolkits/microsoft_teams
- Composio Teams scope/version troubleshooting: https://docs.composio.dev/kb/guide/toolkits-microsoft-teams
- Microsoft Graph list chats: https://learn.microsoft.com/en-us/graph/api/chat-list
- Microsoft Graph list chat messages: https://learn.microsoft.com/en-us/graph/api/chat-list-messages
- Microsoft Graph list channel messages: https://learn.microsoft.com/en-us/graph/api/channel-list-messages
- Microsoft Graph Teams message search limitations: https://learn.microsoft.com/en-us/graph/search-concept-chat-messages
- Microsoft Graph `chatMessage` resource and ID scope: https://learn.microsoft.com/en-us/graph/api/resources/chatmessage
- Microsoft Graph permissions reference: https://learn.microsoft.com/en-us/graph/permissions-reference
