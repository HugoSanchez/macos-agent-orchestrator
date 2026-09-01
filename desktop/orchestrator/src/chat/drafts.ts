import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { json, route, type Route } from '../http/router.ts';
import { ChatStore } from './chat-store.ts';
import {
  ComposioBridgeHttpError,
  type ComposioBridgeService,
} from '../integrations/composio-bridge.ts';
import {
  reviewedMessageToolSlug,
  SUPPORTED_MESSAGE_DRAFT_CHANNELS,
} from '../integrations/reviewed-message-policy.ts';

interface DraftPayload {
  channel: string;
  targetKind: string;
  teamId: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  threadId: string;
  sessionId: string;
  draftId: string;
}

const DRAFT_APPROVAL_HEADER = 'x-verso-draft-approval-token';

export interface DraftsRouteOptions {
  draftApprovalTokenSha256?: string | null;
}

// Verso dispatches directly from the widget after the model's turn ends.
const MESSAGE_DRAFT_DISPATCH: Record<string, { buildArgs: (p: DraftPayload) => Record<string, unknown> }> = {
  gmail: {
    buildArgs: (p) => {
      const args: Record<string, unknown> = {
        recipient_email: p.to,
        subject: p.subject,
        body: p.body,
        is_html: false,
      };
      if (p.cc) args.cc = p.cc.split(',').map((value) => value.trim()).filter(Boolean);
      return args;
    },
  },
  slack: {
    buildArgs: (p) => {
      const args: Record<string, unknown> = {
        channel: p.to.replace(/^#/, ''),
        markdown_text: p.body,
      };
      if (p.threadId) args.thread_ts = p.threadId;
      return args;
    },
  },
  microsoft_teams: {
    buildArgs: (p) => {
      const args: Record<string, unknown> = {
        target_kind: p.targetKind,
        content: p.body,
        content_type: 'text',
      };
      if (p.targetKind === 'chat') args.chat_id = p.to;
      if (p.targetKind === 'channel') {
        args.team_id = p.teamId;
        args.channel_id = p.to;
      }
      return args;
    },
  },
};

export function buildDraftsRoutes(
  bridge: ComposioBridgeService,
  store: ChatStore,
  options: DraftsRouteOptions = {},
): Route[] {
  const activeSends = new Set<string>();
  const draftApprovalTokenSha256 = options.draftApprovalTokenSha256
    ?? process.env.VERSO_DRAFT_APPROVAL_TOKEN_SHA256?.trim()
    ?? null;

  return [
    // POST /drafts/send — dispatches supported Gmail, Slack, and Teams drafts
    // without re-engaging the model.
    route('POST', '/drafts/send', async (req, res, _params, body) => {
      if (!draftApprovalTokenSha256) {
        return json(res, 503, {
          error: 'approval_unavailable',
          message: 'Native message approval is not configured.',
        });
      }
      if (!hasValidDraftApproval(req, draftApprovalTokenSha256)) {
        return json(res, 403, {
          error: 'approval_required',
          message: 'Sending this message requires approval from the native draft widget.',
        });
      }

      let payload: DraftPayload;
      try {
        payload = parseDraftPayload(body);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, 400, { error: 'bad_request', message });
      }

      const dispatch = MESSAGE_DRAFT_DISPATCH[payload.channel];
      if (!dispatch) {
        return json(res, 400, {
          error: 'bad_request',
          message: `Channel "${payload.channel}" is not supported. Drafts are limited to Gmail, Slack, and Microsoft Teams.`,
        });
      }
      if (!payload.sessionId) {
        return json(res, 400, { error: 'bad_request', message: 'Field "sessionId" is required' });
      }
      if (!payload.draftId) {
        return json(res, 400, { error: 'bad_request', message: 'Field "draftId" is required' });
      }
      if (!store.getSessionRecord(payload.sessionId)) {
        return json(res, 404, {
          error: 'not_found',
          message: `Unknown session: ${payload.sessionId}`,
        });
      }

      const sendKey = `${payload.sessionId}\u0000${payload.draftId}`;
      const existingResolution = store.listDraftResolutions(payload.sessionId)
        .find((resolution) => resolution.draftId === payload.draftId);
      if (existingResolution || activeSends.has(sendKey)) {
        return json(res, 409, {
          error: 'draft_resolved',
          message: existingResolution
            ? `Draft has already been ${existingResolution.status}.`
            : 'Draft is already being sent.',
          status: existingResolution?.status ?? 'sending',
        });
      }

      activeSends.add(sendKey);
      try {
        const arguments_ = dispatch.buildArgs(payload);
        const toolSlug = reviewedMessageToolSlug(payload.channel, arguments_);
        if (!toolSlug) {
          throw new ComposioBridgeHttpError(400, 'The reviewed message target is not supported.');
        }
        const result = await bridge.sendReviewedMessage(payload.channel, arguments_);
        if (result.error) {
          return json(res, 502, {
            error: 'send_failed',
            message: result.error,
            channel: payload.channel,
            toolSlug,
          });
        }
        store.recordDraftResolution(payload.sessionId, payload.draftId, 'sent', payload.channel);
        json(res, 200, { status: 'sent', channel: payload.channel, toolSlug, result: result.data });
      } catch (error: unknown) {
        if (error instanceof ComposioBridgeHttpError) {
          return json(res, error.status, { error: 'send_failed', message: error.message });
        }
        const message = error instanceof Error ? error.message : String(error);
        json(res, 500, { error: 'internal_error', message });
      } finally {
        activeSends.delete(sendKey);
      }
    }),

    // POST /drafts/:id/discard — records a durable final state so reopened
    // sessions do not resurrect discarded widgets.
    route('POST', '/drafts/:id/discard', async (_req, res, params, body) => {
      const payload = parseDiscardPayload(body);
      if (!payload.sessionId) {
        return json(res, 400, { error: 'bad_request', message: 'Field "sessionId" is required' });
      }
      if (!payload.channel) {
        return json(res, 400, { error: 'bad_request', message: 'Field "channel" is required' });
      }
      if (!SUPPORTED_MESSAGE_DRAFT_CHANNELS.has(payload.channel)) {
        return json(res, 400, {
          error: 'bad_request',
          message: `Channel "${payload.channel}" is not supported. Drafts are limited to Gmail, Slack, and Microsoft Teams.`,
        });
      }
      const sendKey = `${payload.sessionId}\u0000${params.id}`;
      if (activeSends.has(sendKey)) {
        return json(res, 409, {
          error: 'draft_sending',
          message: 'Draft is already being sent and can no longer be discarded.',
        });
      }
      const resolution = store.recordDraftResolution(payload.sessionId, params.id, 'discarded', payload.channel);
      if (!resolution) {
        return json(res, 404, {
          error: 'not_found',
          message: `Unknown session: ${payload.sessionId}`,
        });
      }
      json(res, 200, { status: 'discarded', draftId: params.id });
    }),

  ];
}

function parseDraftPayload(body: unknown): DraftPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Missing JSON body');
  }
  const record = body as Record<string, unknown>;
  const channel = stringField(record.channel).toLowerCase();
  const to = stringField(record.to);
  const body_ = stringField(record.body);
  const teamId = stringField(record.teamId) || stringField(record.team_id);
  let targetKind = (stringField(record.targetKind) || stringField(record.target_kind)).toLowerCase();
  if (!channel) throw new Error('Field "channel" is required');
  if (!to) throw new Error('Field "to" is required');
  if (!body_) throw new Error('Field "body" is required');
  if (channel === 'microsoft_teams') {
    if (!targetKind) {
      targetKind = /^(me|myself|self|yourself)$/i.test(to)
        ? 'self'
        : teamId
          ? 'channel'
          : 'chat';
    }
    if (!['self', 'chat', 'channel'].includes(targetKind)) {
      throw new Error('Field "target_kind" must be self, chat, or channel for Microsoft Teams');
    }
    if (targetKind === 'channel' && !teamId) {
      throw new Error('Field "team_id" is required for a Microsoft Teams channel message');
    }
  }
  return {
    channel,
    targetKind,
    teamId,
    to,
    cc: stringField(record.cc),
    subject: stringField(record.subject),
    body: body_,
    threadId: stringField(record.threadId),
    sessionId: stringField(record.sessionId),
    draftId: stringField(record.draftId),
  };
}

function parseDiscardPayload(body: unknown): { sessionId: string; channel: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { sessionId: '', channel: '' };
  }
  const record = body as Record<string, unknown>;
  return {
    sessionId: stringField(record.sessionId),
    channel: stringField(record.channel).toLowerCase(),
  };
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function hasValidDraftApproval(req: IncomingMessage, expectedSha256: string): boolean {
  const header = req.headers[DRAFT_APPROVAL_HEADER];
  const token = typeof header === 'string'
    ? header
    : Array.isArray(header) && typeof header[0] === 'string'
      ? header[0]
      : '';
  if (!token) return false;

  const expected = Buffer.from(expectedSha256.toLowerCase(), 'utf8');
  const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
