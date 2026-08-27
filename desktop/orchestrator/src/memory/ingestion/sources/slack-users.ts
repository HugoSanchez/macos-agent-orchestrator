import { asString, type IngestionBridge } from '../ingestion-source.ts';

const SLACK_FIND_USERS = 'SLACK_FIND_USERS';

/**
 * Resolves Slack user ids (Uxxxx / Wxxxx) to human display names so ingested
 * messages read "Hugo Sanchez: …" instead of "U0A4NP3GTHU: …".
 *
 * Cardinal rule (same as the embedder): enrichment must NEVER break ingestion.
 * A failed lookup, a missing scope, or an unparseable response falls back to the
 * raw id — resolve() never throws. Results are cached in-process (names are
 * stable within a workspace), so a busy channel resolves each participant once.
 * The cache resets on restart, which is when transient failures get retried.
 */
export interface SlackUserDirectory {
  /** Map every id to a display name, falling back to the id itself. Never rejects. */
  resolve(userIds: Iterable<string>): Promise<Map<string, string>>;
}

/** A no-op directory (tests / when resolution is disabled): every id maps to itself. */
export const identityUserDirectory: SlackUserDirectory = {
  async resolve(userIds) {
    const map = new Map<string, string>();
    for (const id of userIds) map.set(id, id);
    return map;
  },
};

export class ComposioSlackUserDirectory implements SlackUserDirectory {
  private readonly cache = new Map<string, string>();

  constructor(private readonly bridge: IngestionBridge) {}

  async resolve(userIds: Iterable<string>): Promise<Map<string, string>> {
    const wanted = new Set<string>();
    for (const id of userIds) {
      if (isSlackUserId(id) && !this.cache.has(id)) wanted.add(id);
    }
    // Sequential on purpose: SLACK_FIND_USERS warns about HTTP 429 on repeated
    // calls, and the per-tick fan-out is small (a handful of new participants).
    for (const id of wanted) {
      this.cache.set(id, await this.lookup(id));
    }

    const out = new Map<string, string>();
    for (const id of userIds) {
      if (id) out.set(id, this.cache.get(id) ?? id);
    }
    return out;
  }

  /** One id → display name. Returns the id on any failure (cached so we don't retry it this run). */
  private async lookup(id: string): Promise<string> {
    try {
      const res = await this.bridge.executeTool(
        SLACK_FIND_USERS,
        { search_query: id, exact_match: true, limit: 1 },
        { recordUsage: false },
      );
      if (res.error) return id;
      return pickDisplayName(res.data, id) ?? id;
    } catch {
      return id;
    }
  }
}

/**
 * Pull a display name out of a SLACK_FIND_USERS response. The exact envelope
 * varies (users.info vs. search), so we walk the payload for the first
 * user-shaped object whose id matches (or, failing an id match, the first one
 * with a usable name) and prefer display_name → real_name → name.
 */
export function pickDisplayName(data: unknown, id: string): string | null {
  let fallback: string | null = null;
  const visit = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = visit(child);
        if (hit) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    const name = nameOf(obj);
    if (name) {
      if (asString(obj.id) === id) return name; // exact id match wins
      fallback ??= name; // otherwise remember the first plausible name
    }
    for (const value of Object.values(obj)) {
      const hit = visit(value);
      if (hit) return hit;
    }
    return null;
  };
  return visit(data) ?? fallback;
}

/** Slack user ids are Uxxxx (people) or Wxxxx (Enterprise Grid). Guards against resolving fallbacks like "unknown". */
export function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

/** display_name → real_name → name, checking a nested `profile` too. */
function nameOf(obj: Record<string, unknown>): string | null {
  const profile = (obj.profile && typeof obj.profile === 'object' ? obj.profile : {}) as Record<string, unknown>;
  const candidate =
    asString(profile.display_name) ||
    asString(profile.real_name) ||
    asString(obj.real_name) ||
    asString(obj.display_name) ||
    asString(obj.name);
  return candidate || null;
}
