import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';

// Verified against Composio microsoft_teams 20260804_00. These are the current
// v3.1 opaque-page-token tools; similarly named chat tools are deprecated.
const GET_PROFILE = 'MICROSOFT_TEAMS_GET_MY_PROFILE';
const LIST_CHATS = 'MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS';
const LIST_CHAT_MEMBERS = 'MICROSOFT_TEAMS_LIST_USER_CHAT_MEMBERS';
const LIST_CHAT_MESSAGES = 'MICROSOFT_TEAMS_LIST_USER_CHAT_MESSAGES';
const LIST_JOINED_TEAMS = 'MICROSOFT_TEAMS_LIST_USER_JOINED_TEAMS';
const LIST_ASSOCIATED_TEAMS = 'MICROSOFT_TEAMS_LIST_ASSOCIATED_TEAMS';
const LIST_CHANNELS = 'MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS';
const LIST_CHANNEL_MESSAGES = 'MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES';
const LIST_MESSAGE_REPLIES = 'MICROSOFT_TEAMS_LIST_MESSAGE_REPLIES';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_TOOL_CALLS = 20;
const MAX_TARGETS = 1_000;
const MAX_TEAMS = 500;
const MAX_CHANNELS_PER_TEAM = 500;
const MAX_PAGE_TOKEN_LENGTH = 16 * 1024;
const MAX_CURSOR_LENGTH = 1024 * 1024;
const DEFAULT_CONTENT_LIMIT = 4_000;
const DEFAULT_RESOURCE_INTERVAL_MS = 1_000;

type Phase = 'idle' | 'profile' | 'chats' | 'joined_teams' | 'associated_teams' | 'channels' | 'drain';

interface TeamRef {
  id: string;
  name: string;
}

interface ChatTarget {
  kind: 'chat';
  id: string;
  chatType: string;
  label: string;
  enrichmentDone: boolean;
}

interface ChannelTarget {
  kind: 'channel';
  id: string;
  teamId: string;
  label: string;
}

type TeamsTarget = ChatTarget | ChannelTarget;

export interface TeamsCursorV1 {
  v: 1;
  watermark: string;
  hasCompletedCycle: boolean;
  upperBound: string | null;
  replayFloor: string | null;
  phase: Phase;
  userId: string;
  pageToken: string | null;
  teams: TeamRef[];
  teamIndex: number;
  teamChannelCount: number;
  targets: TeamsTarget[];
  targetIndex: number;
  consumedPageIds: string[];
  channelRootIds: string[];
  channelRootIndex: number;
  nextRootPageToken: string | null;
  channelPageHasRecent: boolean;
  channelRootsEmitted: boolean;
  consumedRootIds: string[];
  replyPageToken: string | null;
  consumedReplyIds: string[];
}

interface ProviderPage {
  items: unknown[];
  nextPageToken: string | null;
}

interface ParsedMessage {
  id: string;
  createdMs: number;
  occurredAt: string;
  author: string;
  text: string;
}

/**
 * Passive Teams ingestion with Slack-equivalent coverage: 1:1/group chats,
 * channels, and channel replies. Discovery and nested message pagination live
 * in one versioned cursor so the generic scheduler can stop at either budget
 * and resume without committing a watermark over unvisited conversations.
 */
export class TeamsSource implements SourceAdapter {
  readonly source = 'teams';
  readonly displayName = 'Microsoft Teams';
  readonly logoUrl = 'https://logos.composio.dev/api/microsoft_teams';
  readonly defaultStream = '';
  readonly seedLookbackMs = DAY_MS;

  private readonly contentLimit: number;
  private readonly maxToolCalls: number;
  private readonly resourceIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clockMs: () => number;
  private readonly lastResourceCallAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(
    private readonly bridge: IngestionBridge,
    opts: {
      contentLimit?: number;
      maxToolCalls?: number;
      now?: () => Date;
      resourceIntervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
      clockMs?: () => number;
    } = {},
  ) {
    this.contentLimit = opts.contentLimit ?? DEFAULT_CONTENT_LIMIT;
    this.maxToolCalls = opts.maxToolCalls ?? MAX_TOOL_CALLS;
    this.resourceIntervalMs = Math.max(0, opts.resourceIntervalMs ?? DEFAULT_RESOURCE_INTERVAL_MS);
    this.sleep = opts.sleep ?? (process.env.NODE_ENV === 'test'
      ? (async () => undefined)
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.clockMs = opts.clockMs ?? Date.now;
    this.now = opts.now ?? (() => new Date());
  }

  seedCursor(now: Date, lookbackMs: number): string {
    return serializeCursor(emptyCursor(new Date(Math.max(0, now.getTime() - lookbackMs)).toISOString()));
  }

  async fetchSince(_stream: string, cursorString: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const now = this.now();
    const fallbackFloor = new Date(Math.max(0, now.getTime() - DAY_MS)).toISOString();
    const cursor = parseTeamsCursor(cursorString, fallbackFloor, now);
    const items: IngestionItem[] = [];
    let calls = 0;

    const execute = async (slug: string, args: Record<string, unknown>, resourceKey?: string): Promise<unknown> => {
      if (resourceKey) await this.paceResource(resourceKey);
      calls += 1;
      let response: Awaited<ReturnType<IngestionBridge['executeTool']>>;
      try {
        response = await this.bridge.executeTool(slug, args, { recordUsage: false });
      } catch (error: unknown) {
        throw new Error(`${slug} failed: ${sanitizeError(error)}`);
      }
      if (response.error) throw new Error(`${slug} failed: ${sanitizeError(response.error)}`);
      return response.data;
    };

    const result = (hasMore = true): IngestionFetchResult => ({
      items: items.sort((a, b) => a.cursorValue - b.cursorValue || (a.dedupRef ?? '').localeCompare(b.dedupRef ?? '')),
      nextCursor: serializeCursor(cursor),
      hasMore,
    });

    while (true) {
      if (items.length >= Math.max(0, opts.maxItems) || calls >= this.maxToolCalls) return result();

      if (cursor.phase === 'idle') {
        const watermarkMs = Date.parse(cursor.watermark);
        cursor.upperBound = now.toISOString();
        cursor.replayFloor = new Date(Math.max(
          0,
          watermarkMs - (cursor.hasCompletedCycle ? DAY_MS : 0),
        )).toISOString();
        cursor.phase = 'profile';
        cursor.userId = 'me';
        resetDiscovery(cursor);
        continue;
      }

      if (cursor.phase === 'profile') {
        // Profile resolution is enrichment: current schemas accept `me` for
        // discovery, while chat-message reads are more reliable with a GUID.
        try {
          const data = await execute(GET_PROFILE, { user_id: 'me', select: 'id,displayName,userPrincipalName' });
          cursor.userId = findString(data, ['id', 'user_id', 'userId']) || 'me';
        } catch {
          cursor.userId = 'me';
        }
        cursor.phase = 'chats';
        return result();
      }

      if (cursor.phase === 'chats') {
        const data = await execute(LIST_CHATS, compactArgs({
          user_id: cursor.userId,
          top: PAGE_SIZE,
          limit: PAGE_SIZE,
          select: ['id', 'topic', 'chatType'],
          page_token: cursor.pageToken,
        }), `user-chats:${cursor.userId}`);
        const page = extractProviderPage(data, ['chats']);
        for (const raw of page.items) addChatTarget(cursor, raw);
        cursor.pageToken = page.nextPageToken;
        assertCursorBounds(cursor);
        if (!cursor.pageToken) {
          cursor.phase = 'joined_teams';
        }
        return result();
      }

      if (cursor.phase === 'joined_teams' || cursor.phase === 'associated_teams') {
        const slug = cursor.phase === 'joined_teams' ? LIST_JOINED_TEAMS : LIST_ASSOCIATED_TEAMS;
        const data = await execute(
          slug,
          compactArgs({ user_id: cursor.userId, page_token: cursor.pageToken }),
          `user-teams:${cursor.userId}`,
        );
        const page = extractProviderPage(data, ['teams', 'joinedTeams', 'associatedTeams']);
        for (const raw of page.items) addTeam(cursor, raw);
        cursor.pageToken = page.nextPageToken;
        assertCursorBounds(cursor);
        if (!cursor.pageToken) {
          if (cursor.phase === 'joined_teams') {
            cursor.phase = 'associated_teams';
          } else {
            cursor.phase = 'channels';
            cursor.teamIndex = 0;
            cursor.teamChannelCount = 0;
          }
        }
        return result();
      }

      if (cursor.phase === 'channels') {
        if (cursor.teamIndex >= cursor.teams.length) {
          cursor.phase = 'drain';
          cursor.pageToken = null;
          cursor.targetIndex = 0;
          continue;
        }
        const team = cursor.teams[cursor.teamIndex];
        const data = await execute(LIST_CHANNELS, compactArgs({
          team_id: team.id,
          include_shared_channels: true,
          select: 'id,displayName,membershipType',
          page_token: cursor.pageToken,
        }), `team:${team.id}`);
        const page = extractProviderPage(data, ['channels']);
        cursor.teamChannelCount += page.items.length;
        if (cursor.teamChannelCount > MAX_CHANNELS_PER_TEAM) {
          throw new Error(`Microsoft Teams discovery exceeded ${MAX_CHANNELS_PER_TEAM} channels for one team.`);
        }
        for (const raw of page.items) addChannelTarget(cursor, team, raw);
        cursor.pageToken = page.nextPageToken;
        assertCursorBounds(cursor);
        if (!cursor.pageToken) {
          cursor.teamIndex += 1;
          cursor.teamChannelCount = 0;
        }
        return result();
      }

      const target = cursor.targets[cursor.targetIndex];
      if (!target) {
        const completedAt = cursor.upperBound ?? cursor.watermark;
        const completed = emptyCursor(completedAt);
        completed.hasCompletedCycle = true;
        Object.assign(cursor, completed);
        return result(false);
      }

      if (target.kind === 'chat') {
        if (!target.enrichmentDone) {
          try {
            const data = await execute(
              LIST_CHAT_MEMBERS,
              { user_id: cursor.userId, chat_id: target.id },
              targetKey(target),
            );
            target.label = enrichedChatLabel(target, extractArray(data, ['members']), cursor.userId);
          } catch {
            // A missing name should not suppress the chat's messages.
          }
          target.enrichmentDone = true;
          return result();
        }
        const remaining = Math.max(1, opts.maxItems - items.length);
        let data: unknown;
        try {
          data = await execute(LIST_CHAT_MESSAGES, compactArgs({
            user_id: cursor.userId,
            chat_id: target.id,
            top: Math.min(PAGE_SIZE, remaining),
            // Graph supports strict gt/lt here; local acceptance remains (floor, upper].
            filter: `lastModifiedDateTime gt ${cursor.replayFloor} and lastModifiedDateTime lt ${cursor.upperBound}`,
            orderby: 'lastModifiedDateTime desc',
            page_token: cursor.pageToken,
          }), targetKey(target));
        } catch (error: unknown) {
          if (!isUnambiguouslyMissingTarget(error)) throw error;
          advanceTarget(cursor);
          return result();
        }
        const page = extractProviderPage(data, ['messages', 'chatMessages']);
        const consumed = new Set(cursor.consumedPageIds);
        const candidates = page.items.filter((raw) => {
          const id = messageId(raw);
          return !id || !consumed.has(id);
        });
        let stoppedMidPage = false;
        for (const raw of candidates) {
          const id = messageId(raw);
          if (items.length >= opts.maxItems) {
            stoppedMidPage = true;
            break;
          }
          if (id) consumed.add(id);
          const item = toIngestionItem(raw, target, cursor, this.contentLimit);
          if (item) items.push(item);
        }
        if (stoppedMidPage) {
          cursor.consumedPageIds = boundedIds(consumed);
          return result();
        }
        cursor.consumedPageIds = [];
        cursor.pageToken = page.nextPageToken;
        if (!cursor.pageToken) advanceTarget(cursor);
        return result();
      }

      // Emit each root page atomically, then drain replies from its persisted IDs.
      if (cursor.channelRootsEmitted && cursor.channelRootIndex >= cursor.channelRootIds.length) {
        cursor.pageToken = cursor.channelPageHasRecent ? cursor.nextRootPageToken : null;
        resetChannelPage(cursor);
        if (!cursor.pageToken) advanceTarget(cursor);
        continue;
      }

      if (!cursor.channelRootsEmitted) {
        let rootPage: ProviderPage | null;
        try {
          rootPage = await this.fetchChannelRootPage(cursor, target, execute);
        } catch (error: unknown) {
          if (!isUnambiguouslyMissingTarget(error)) throw error;
          advanceTarget(cursor);
          return result();
        }
        if (!rootPage) {
          advanceTarget(cursor);
          continue;
        }
        const consumedRoots = new Set(cursor.consumedRootIds);
        let stoppedMidPage = false;
        for (const raw of rootPage.items) {
          const id = messageId(raw);
          if (!id || consumedRoots.has(id)) continue;
          if (items.length >= opts.maxItems) {
            stoppedMidPage = true;
            break;
          }
          consumedRoots.add(id);
          if (isRecentChainRecord(raw, cursor)) cursor.channelPageHasRecent = true;
          const item = toIngestionItem(raw, target, cursor, this.contentLimit);
          if (item) items.push(item);
        }
        if (stoppedMidPage) {
          cursor.consumedRootIds = boundedIds(consumedRoots);
          return result();
        }
        cursor.consumedRootIds = [];
        cursor.channelRootsEmitted = true;
        cursor.channelRootIndex = 0;
        // Commit after each channel request. If a later request is throttled,
        // the scheduler never has to replay a long uncommitted channel burst.
        return result();
      }

      const rootId = cursor.channelRootIds[cursor.channelRootIndex];

      const remaining = Math.max(1, opts.maxItems - items.length);
      let data: unknown;
      try {
        data = await execute(LIST_MESSAGE_REPLIES, compactArgs({
          team_id: target.teamId,
          channel_id: target.id,
          message_id: rootId,
          top: Math.min(PAGE_SIZE, remaining),
          page_token: cursor.replyPageToken,
        }), targetKey(target));
      } catch (error: unknown) {
        if (!isUnambiguouslyMissingTarget(error)) throw error;
        cursor.replyPageToken = null;
        cursor.consumedReplyIds = [];
        cursor.channelRootIndex += 1;
        return result();
      }
      const replyPage = extractProviderPage(data, ['replies', 'messages']);
      const consumed = new Set(cursor.consumedReplyIds);
      let stoppedMidPage = false;
      for (const raw of replyPage.items) {
        const id = messageId(raw);
        if (id && consumed.has(id)) continue;
        if (items.length >= opts.maxItems) {
          stoppedMidPage = true;
          break;
        }
        if (id) consumed.add(id);
        if (isRecentChainRecord(raw, cursor)) cursor.channelPageHasRecent = true;
        const item = toIngestionItem(raw, target, cursor, this.contentLimit, rootId);
        if (item) items.push(item);
      }
      if (stoppedMidPage) {
        cursor.consumedReplyIds = boundedIds(consumed);
        return result();
      }
      cursor.consumedReplyIds = [];
      cursor.replyPageToken = replyPage.nextPageToken;
      if (!cursor.replyPageToken) {
        cursor.channelRootIndex += 1;
      }
      // The next scheduler tick is immediate (`hasMore`) and resource pacing
      // keeps it at least one second after this channel request.
      return result();
    }
  }

  private async paceResource(resourceKey: string): Promise<void> {
    const previous = this.lastResourceCallAt.get(resourceKey);
    if (previous !== undefined) {
      const remaining = this.resourceIntervalMs - (this.clockMs() - previous);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastResourceCallAt.set(resourceKey, this.clockMs());
  }

  private async fetchChannelRootPage(
    cursor: TeamsCursorV1,
    target: ChannelTarget,
    execute: (slug: string, args: Record<string, unknown>, resourceKey?: string) => Promise<unknown>,
  ): Promise<ProviderPage | null> {
    const data = await execute(LIST_CHANNEL_MESSAGES, compactArgs({
      team_id: target.teamId,
      channel_id: target.id,
      top: PAGE_SIZE,
      page_token: cursor.pageToken,
    }), targetKey(target));
    const page = extractProviderPage(data, ['messages', 'channelMessages']);
    if (cursor.channelRootIds.length === 0) {
      if (page.items.length === 0) return null;
      cursor.channelRootIds = page.items.map(messageId).filter(Boolean);
      cursor.nextRootPageToken = page.nextPageToken;
      cursor.channelRootIndex = 0;
      cursor.channelPageHasRecent = false;
      cursor.consumedRootIds = [];
    }
    return page;
  }
}

function emptyCursor(watermark: string): TeamsCursorV1 {
  return {
    v: 1,
    watermark,
    hasCompletedCycle: false,
    upperBound: null,
    replayFloor: null,
    phase: 'idle',
    userId: 'me',
    pageToken: null,
    teams: [],
    teamIndex: 0,
    teamChannelCount: 0,
    targets: [],
    targetIndex: 0,
    consumedPageIds: [],
    channelRootIds: [],
    channelRootIndex: 0,
    nextRootPageToken: null,
    channelPageHasRecent: false,
    channelRootsEmitted: false,
    consumedRootIds: [],
    replyPageToken: null,
    consumedReplyIds: [],
  };
}

export function parseTeamsCursor(value: string, fallbackFloor: string, now = new Date()): TeamsCursorV1 {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { v?: unknown }).v === 1) {
    const raw = parsed as Partial<TeamsCursorV1>;
    const watermark = validWatermark(raw.watermark, fallbackFloor, now);
    const cursor = emptyCursor(watermark);
    cursor.hasCompletedCycle = raw.hasCompletedCycle === true;
    cursor.upperBound = validIso(raw.upperBound) ? raw.upperBound : null;
    cursor.replayFloor = validIso(raw.replayFloor) ? raw.replayFloor : null;
    cursor.phase = isPhase(raw.phase) ? raw.phase : 'idle';
    cursor.userId = boundedString(raw.userId, 500) || 'me';
    cursor.pageToken = pageToken(raw.pageToken);
    cursor.teams = checkedRecordArray(raw.teams, MAX_TEAMS, isTeamRef, 'teams');
    cursor.teamIndex = boundedIndex(raw.teamIndex);
    cursor.teamChannelCount = boundedIndex(raw.teamChannelCount);
    cursor.targets = checkedRecordArray(raw.targets, MAX_TARGETS, isTarget, 'targets');
    cursor.targetIndex = boundedIndex(raw.targetIndex);
    cursor.consumedPageIds = checkedStringArray(raw.consumedPageIds, PAGE_SIZE, 'consumed message IDs');
    cursor.channelRootIds = checkedStringArray(raw.channelRootIds, PAGE_SIZE, 'channel root IDs');
    cursor.channelRootIndex = boundedIndex(raw.channelRootIndex);
    cursor.nextRootPageToken = pageToken(raw.nextRootPageToken);
    cursor.channelPageHasRecent = raw.channelPageHasRecent === true;
    cursor.channelRootsEmitted = raw.channelRootsEmitted === true;
    cursor.consumedRootIds = checkedStringArray(raw.consumedRootIds, PAGE_SIZE, 'consumed root IDs');
    cursor.replyPageToken = pageToken(raw.replyPageToken);
    cursor.consumedReplyIds = checkedStringArray(raw.consumedReplyIds, PAGE_SIZE, 'consumed reply IDs');
    // A transient phase without its fixed boundaries cannot resume safely.
    if (cursor.phase !== 'idle' && (!cursor.upperBound || !cursor.replayFloor)) return emptyCursor(watermark);
    return cursor;
  }
  const legacy = typeof parsed === 'number' ? parsed : asString(parsed).trim();
  if (legacy === '') return emptyCursor(fallbackFloor);
  const rawLegacy = Number(legacy);
  const numericLegacy = Number.isFinite(rawLegacy)
    ? (rawLegacy > 0 && rawLegacy < 1_000_000_000_000 ? rawLegacy * 1_000 : rawLegacy)
    : Number.NaN;
  const legacyMs = Number.isFinite(numericLegacy) ? numericLegacy : Date.parse(asString(parsed));
  const watermark = Number.isFinite(legacyMs)
    ? validWatermark(new Date(legacyMs).toISOString(), fallbackFloor, now)
    : fallbackFloor;
  return emptyCursor(watermark);
}

function validWatermark(value: unknown, fallback: string, now: Date): string {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) && parsed <= now.getTime() + 60_000
    ? new Date(Math.max(0, parsed)).toISOString()
    : fallback;
}

function serializeCursor(cursor: TeamsCursorV1): string {
  assertCursorBounds(cursor);
  const serialized = JSON.stringify(cursor);
  if (serialized.length > MAX_CURSOR_LENGTH) throw new Error('Microsoft Teams ingestion cursor exceeded 1 MiB.');
  return serialized;
}

function resetDiscovery(cursor: TeamsCursorV1): void {
  cursor.pageToken = null;
  cursor.teams = [];
  cursor.teamIndex = 0;
  cursor.teamChannelCount = 0;
  cursor.targets = [];
  cursor.targetIndex = 0;
  cursor.consumedPageIds = [];
  resetChannelPage(cursor);
}

function resetChannelPage(cursor: TeamsCursorV1): void {
  cursor.channelRootIds = [];
  cursor.channelRootIndex = 0;
  cursor.nextRootPageToken = null;
  cursor.channelPageHasRecent = false;
  cursor.channelRootsEmitted = false;
  cursor.consumedRootIds = [];
  cursor.replyPageToken = null;
  cursor.consumedReplyIds = [];
}

function advanceTarget(cursor: TeamsCursorV1): void {
  cursor.targetIndex += 1;
  cursor.pageToken = null;
  cursor.consumedPageIds = [];
  resetChannelPage(cursor);
}

function addChatTarget(cursor: TeamsCursorV1, raw: unknown): void {
  const chat = asRecord(raw);
  const id = boundedString(chat?.id, 2_000);
  if (!id) return;
  const chatType = boundedString(chat?.chatType ?? chat?.chat_type, 100).toLowerCase();
  const topic = boundedString(chat?.topic, 300);
  const label = topic || fallbackChatLabel(chatType);
  addTarget(cursor, { kind: 'chat', id, chatType, label, enrichmentDone: false });
}

function addTeam(cursor: TeamsCursorV1, raw: unknown): void {
  const team = asRecord(raw);
  const id = boundedString(team?.id ?? team?.teamId ?? team?.team_id, 2_000);
  if (!id || cursor.teams.some((item) => item.id === id)) return;
  if (cursor.teams.length >= MAX_TEAMS) throw new Error(`Microsoft Teams discovery exceeded ${MAX_TEAMS} teams.`);
  cursor.teams.push({ id, name: boundedString(team?.displayName ?? team?.name, 300) || 'Team' });
}

function addChannelTarget(cursor: TeamsCursorV1, team: TeamRef, raw: unknown): void {
  const channel = asRecord(raw);
  const id = boundedString(channel?.id ?? channel?.channelId ?? channel?.channel_id, 2_000);
  if (!id) return;
  const channelName = boundedString(channel?.displayName ?? channel?.name, 300) || 'channel';
  addTarget(cursor, { kind: 'channel', id, teamId: team.id, label: `${team.name} · #${channelName}` });
}

function addTarget(cursor: TeamsCursorV1, target: TeamsTarget): void {
  const key = targetKey(target);
  if (cursor.targets.some((item) => targetKey(item) === key)) return;
  if (cursor.targets.length >= MAX_TARGETS) throw new Error(`Microsoft Teams discovery exceeded ${MAX_TARGETS} conversations.`);
  cursor.targets.push(target);
}

function targetKey(target: TeamsTarget): string {
  return target.kind === 'chat' ? `chat:${target.id}` : `channel:${target.teamId}:${target.id}`;
}

function fallbackChatLabel(chatType: string): string {
  if (chatType === 'oneonone') return 'One-to-one chat';
  if (chatType.includes('meeting')) return 'Meeting chat';
  return 'Group chat';
}

function enrichedChatLabel(target: ChatTarget, rawMembers: unknown[], currentUserId: string): string {
  const names = rawMembers.map((raw) => {
    const member = asRecord(raw);
    const user = asRecord(member?.user);
    return {
      id: boundedString(member?.userId ?? member?.user_id ?? user?.id, 500),
      name: boundedString(member?.displayName ?? member?.display_name ?? user?.displayName, 300),
    };
  }).filter((member) => member.name);
  if (target.chatType === 'oneonone') {
    const peer = names.find((member) => member.id && member.id !== currentUserId) ?? names[0];
    return peer ? `Chat with ${peer.name}` : target.label;
  }
  if (target.label !== fallbackChatLabel(target.chatType)) return target.label;
  return names.length > 0 ? names.slice(0, 4).map((member) => member.name).join(', ') : target.label;
}

function toIngestionItem(
  raw: unknown,
  target: TeamsTarget,
  cursor: TeamsCursorV1,
  contentLimit: number,
  replyRootId?: string,
): IngestionItem | null {
  const message = parseMessage(raw);
  if (!message) return null;
  const floor = Date.parse(cursor.replayFloor ?? '');
  const upper = Date.parse(cursor.upperBound ?? '');
  if (!Number.isFinite(floor) || !Number.isFinite(upper) || message.createdMs <= floor || message.createdMs > upper) return null;
  const key = targetKey(target);
  const day = message.occurredAt.slice(0, 10);
  const time = message.occurredAt.slice(11, 16);
  const replyPart = replyRootId ? `${replyRootId}:` : '';
  // A one-line record lets the local merge store sort pages chronologically;
  // Teams' Graph endpoints only paginate newest-first.
  const text = message.text.replace(/\s*\n+\s*/g, ' / ');
  return {
    sourceRef: `${key}#${day}`,
    dedupRef: `${key}:${replyPart}${message.id}`,
    cursorValue: message.createdMs,
    occurredAt: message.occurredAt,
    title: `${target.label} ${day}`,
    content: `[${time}] ${message.author}: ${text}`.slice(0, contentLimit),
    merge: true,
    mergeOrder: 'chronological',
  };
}

function parseMessage(raw: unknown): ParsedMessage | null {
  const message = asRecord(raw);
  if (!message || message.deletedDateTime || message.deleted_date_time) return null;
  const id = messageId(message);
  const createdMs = Date.parse(asString(message.createdDateTime ?? message.created_date_time));
  const messageType = asString(message.messageType ?? message.message_type).toLowerCase();
  if (!id || !Number.isFinite(createdMs) || (messageType && messageType !== 'message')) return null;
  const from = asRecord(message.from);
  const user = asRecord(from?.user);
  if (!user || from?.application || from?.device) return null;
  const author = boundedString(user.displayName ?? user.display_name ?? user.id, 300) || 'Unknown';
  const body = asRecord(message.body);
  const rawBody = asString(body?.content ?? message.content);
  const text = asString(body?.contentType ?? body?.content_type).toLowerCase() === 'text'
    ? normalizeWhitespace(rawBody)
    : normalizeTeamsHtml(rawBody, Array.isArray(message.mentions) ? message.mentions : []);
  if (!text) return null;
  return { id, createdMs, occurredAt: new Date(createdMs).toISOString(), author, text };
}

export function normalizeTeamsHtml(html: string, mentions: unknown[] = []): string {
  if (!html) return '';
  const mentionNames = new Map<string, string>();
  for (const raw of mentions) {
    const mention = asRecord(raw);
    const mentioned = asRecord(mention?.mentioned);
    const user = asRecord(mentioned?.user);
    const id = String(mention?.id ?? '');
    const name = boundedString(user?.displayName ?? mention?.mentionText ?? mention?.mention_text, 300);
    if (id && name) mentionNames.set(id, name);
  }
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<([a-z][\w:-]*)\b[^>]*(?:hidden|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<at\b[^>]*\bid\s*=\s*["']?([^\s"'>]+)[^>]*>([\s\S]*?)<\/at\s*>/gi,
      (_full, id: string, visible: string) => `@${mentionNames.get(id) ?? stripTags(visible)}`)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:p|div|li|ul|ol|blockquote|pre|h[1-6]|tr|table|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return normalizeWhitespace(decodeHtmlEntities(text));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? full;
    const radix = entity[1].toLowerCase() === 'x' ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    try {
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : full;
    } catch {
      return full;
    }
  });
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, '')).trim();
}

function extractProviderPage(data: unknown, preferredKeys: string[]): ProviderPage {
  return { items: extractArray(data, preferredKeys), nextPageToken: extractPageToken(data) };
}

function extractArray(data: unknown, preferredKeys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const keys = [...preferredKeys, 'value', 'items', 'data'];
  return findInPayload(data, (record) => {
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key];
    }
  }) ?? [];
}

export function extractPageToken(data: unknown): string | null {
  return findInPayload(data, (record) => {
    for (const key of ['next_page_token', 'nextPageToken', '@odata.nextLink', 'nextLink']) {
      const token = pageToken(record[key]);
      if (token) return token;
    }
  }) ?? null;
}

function findString(data: unknown, keys: string[]): string {
  return findInPayload(data, (record) => {
    for (const key of keys) {
      const found = boundedString(record[key], 2_000);
      if (found) return found;
    }
  }) ?? '';
}

function findInPayload<T>(
  data: unknown,
  match: (record: Record<string, unknown>) => T | undefined,
): T | undefined {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: data, depth: 0 }];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    const record = asRecord(current.value);
    if (!record) continue;
    const found = match(record);
    if (found !== undefined) return found;
    if (current.depth < 3) {
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
}

function messageId(raw: unknown): string {
  const record = asRecord(raw);
  return boundedString(record?.id ?? record?.messageId ?? record?.message_id, 2_000);
}

/**
 * Graph orders channel roots by activity across the whole reply chain, but a
 * root's own lastModifiedDateTime does not prove that its replies are old. We
 * inspect every reply for one page before treating an all-old page as the
 * chronological stop boundary.
 */
function isRecentChainRecord(raw: unknown, cursor: TeamsCursorV1): boolean {
  const record = asRecord(raw);
  const timestamp = Date.parse(
    asString(record?.lastModifiedDateTime ?? record?.last_modified_date_time)
      || asString(record?.createdDateTime ?? record?.created_date_time),
  );
  const floor = Date.parse(cursor.replayFloor ?? '');
  return Number.isFinite(timestamp) && Number.isFinite(floor) && timestamp > floor;
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function boundedIds(ids: Set<string>): string[] {
  const values = [...ids];
  if (values.length > PAGE_SIZE) throw new Error(`Microsoft Teams returned more than ${PAGE_SIZE} messages in one page.`);
  return values;
}

function assertCursorBounds(cursor: TeamsCursorV1): void {
  if (cursor.teams.length > MAX_TEAMS) throw new Error(`Microsoft Teams discovery exceeded ${MAX_TEAMS} teams.`);
  if (cursor.targets.length > MAX_TARGETS) throw new Error(`Microsoft Teams discovery exceeded ${MAX_TARGETS} conversations.`);
  for (const token of [cursor.pageToken, cursor.nextRootPageToken, cursor.replyPageToken]) {
    if (token && token.length > MAX_PAGE_TOKEN_LENGTH) throw new Error('Microsoft Teams returned an oversized page token.');
  }
  if (
    cursor.consumedPageIds.length > PAGE_SIZE
    || cursor.consumedRootIds.length > PAGE_SIZE
    || cursor.consumedReplyIds.length > PAGE_SIZE
    || cursor.channelRootIds.length > PAGE_SIZE
  ) {
    throw new Error(`Microsoft Teams returned more than ${PAGE_SIZE} messages in one page.`);
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/(bearer|token|secret)\s*[:=]\s*\S+/gi, '$1=<redacted>').slice(0, 500);
}

function isUnambiguouslyMissingTarget(error: unknown): boolean {
  const wrapped = error instanceof Error ? error.message : String(error);
  const message = wrapped.replace(/^[A-Z0-9_]+ failed:\s*/i, '');
  return /\b(?:chat|channel|message)\b.{0,120}\b(?:not found|does not exist|was deleted)\b/i.test(message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function pageToken(value: unknown): string | null {
  const token = boundedString(value, MAX_PAGE_TOKEN_LENGTH + 1);
  if (!token) return null;
  if (token.length > MAX_PAGE_TOKEN_LENGTH) throw new Error('Microsoft Teams returned an oversized page token.');
  return token;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function checkedStringArray(value: unknown, limit: number, label: string): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > limit) throw new Error(`Microsoft Teams cursor exceeded the ${limit} ${label} limit.`);
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function checkedRecordArray<T>(
  value: unknown,
  limit: number,
  predicate: (item: unknown) => item is T,
  label: string,
): T[] {
  if (!Array.isArray(value)) return [];
  if (value.length > limit) throw new Error(`Microsoft Teams cursor exceeded the ${limit} ${label} limit.`);
  return value.filter(predicate);
}

function isPhase(value: unknown): value is Phase {
  return ['idle', 'profile', 'chats', 'joined_teams', 'associated_teams', 'channels', 'drain'].includes(String(value));
}

function isTeamRef(value: unknown): value is TeamRef {
  const record = asRecord(value);
  return Boolean(record && boundedString(record.id, 2_000) && typeof record.name === 'string');
}

function isTarget(value: unknown): value is TeamsTarget {
  const record = asRecord(value);
  if (!record || !boundedString(record.id, 2_000) || typeof record.label !== 'string') return false;
  if (record.kind === 'chat') return typeof record.chatType === 'string' && typeof record.enrichmentDone === 'boolean';
  return record.kind === 'channel' && typeof record.teamId === 'string';
}
