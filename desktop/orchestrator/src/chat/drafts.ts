import { json, route, type Route } from '../http/router.ts';
import { ChatStore } from './chat-store.ts';
import {
  ComposioBridgeHttpError,
  SUPPORTED_MESSAGE_DRAFT_CHANNELS,
  type ComposioBridgeService,
} from '../integrations/composio-bridge.ts';

interface DraftPayload {
  channel: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  threadId: string;
  sessionId: string;
  draftId: string;
}

// Verso dispatches directly from the widget after the model's turn ends.
const MESSAGE_DRAFT_DISPATCH: Record<string, { slug: string; buildArgs: (p: DraftPayload) => Record<string, unknown> }> = {
  gmail: {
    slug: 'GMAIL_SEND_EMAIL',
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
    slug: 'SLACK_SEND_MESSAGE',
    buildArgs: (p) => {
      const args: Record<string, unknown> = {
        channel: p.to.replace(/^#/, ''),
        markdown_text: p.body,
      };
      if (p.threadId) args.thread_ts = p.threadId;
      return args;
    },
  },
};

export function buildDraftsRoutes(bridge: ComposioBridgeService, store: ChatStore): Route[] {
  return [
    // POST /drafts/send — dispatches supported Slack/Gmail drafts without
    // re-engaging the model.
    route('POST', '/drafts/send', async (_req, res, _params, body) => {
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
          message: `Channel "${payload.channel}" is not supported. Drafts are limited to Gmail and Slack.`,
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

      try {
        const result = await bridge.executeTool(dispatch.slug, dispatch.buildArgs(payload));
        if (result.error) {
          return json(res, 502, {
            error: 'send_failed',
            message: result.error,
            channel: payload.channel,
            toolSlug: dispatch.slug,
          });
        }
        store.recordDraftResolution(payload.sessionId, payload.draftId, 'sent', payload.channel);
        json(res, 200, { status: 'sent', channel: payload.channel, toolSlug: dispatch.slug, result: result.data });
      } catch (error: unknown) {
        if (error instanceof ComposioBridgeHttpError) {
          return json(res, error.status, { error: 'send_failed', message: error.message });
        }
        const message = error instanceof Error ? error.message : String(error);
        json(res, 500, { error: 'internal_error', message });
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
          message: `Channel "${payload.channel}" is not supported. Drafts are limited to Gmail and Slack.`,
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
  const channel = stringField(record.channel);
  const to = stringField(record.to);
  const body_ = stringField(record.body);
  if (!channel) throw new Error('Field "channel" is required');
  if (!to) throw new Error('Field "to" is required');
  if (!body_) throw new Error('Field "body" is required');
  return {
    channel,
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
    channel: stringField(record.channel),
  };
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}
