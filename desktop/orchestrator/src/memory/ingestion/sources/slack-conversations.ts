import { asString, type IngestionBridge } from '../ingestion-source.ts';

const SLACK_LIST_CONVERSATIONS = 'SLACK_LIST_CONVERSATIONS';

/**
 * Maps Slack DM (IM) channel ids to the other participant's user id, so a DM
 * document can be titled "DM with Alice" instead of a bare "DM". The peer id is
 * then resolved to a name by the user directory (same path as message authors).
 *
 * Same cardinal rule as the user directory: enrichment must NEVER break
 * ingestion. resolve() never throws; on any failure a channel simply isn't in
 * the returned map and the caller falls back to "DM". The IM list is fetched
 * once per process and cached (DMs are stable); new DMs created mid-run resolve
 * after the next restart.
 */
export interface SlackConversationDirectory {
  /** channelId → peer user id, for whichever of the requested IM channels resolve. Never rejects. */
  peerIds(imChannelIds: Iterable<string>): Promise<Map<string, string>>;
}

/** A no-op directory (tests / disabled): resolves no peers, so DMs stay labeled "DM". */
export const emptyConversationDirectory: SlackConversationDirectory = {
  async peerIds() {
    return new Map();
  },
};

export class ComposioSlackConversationDirectory implements SlackConversationDirectory {
  private cache: Map<string, string> | null = null;

  constructor(private readonly bridge: IngestionBridge) {}

  async peerIds(imChannelIds: Iterable<string>): Promise<Map<string, string>> {
    const wanted = [...imChannelIds].filter((id) => id);
    if (wanted.length === 0) return new Map();

    const directory = await this.ensureDirectory();
    const out = new Map<string, string>();
    for (const id of wanted) {
      const peer = directory.get(id);
      if (peer) out.set(id, peer);
    }
    return out;
  }

  /** Fetch-and-cache the IM directory once; returns an empty map on any failure (retried next process). */
  private async ensureDirectory(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    const map = new Map<string, string>();
    try {
      const res = await this.bridge.executeTool(
        SLACK_LIST_CONVERSATIONS,
        { types: 'im', limit: 1000 },
        { recordUsage: false },
      );
      if (!res.error) collectImPeers(res.data, map);
    } catch {
      // leave the map empty; DMs fall back to "DM"
    }
    this.cache = map;
    return map;
  }
}

/** Walk a SLACK_LIST_CONVERSATIONS payload for IM entries, recording channelId → peer user id. */
export function collectImPeers(data: unknown, into: Map<string, string>): Map<string, string> {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const obj = node as Record<string, unknown>;
    const id = asString(obj.id);
    const user = asString(obj.user);
    if (obj.is_im === true && id && user) into.set(id, user);
    for (const value of Object.values(obj)) visit(value);
  };
  visit(data);
  return into;
}
