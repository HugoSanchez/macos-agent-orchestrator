import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { json, route, type Route } from '../http/router.ts';
import { HermesSupervisor } from '../hermes/hermes-supervisor.ts';
import { hermesOneShotText } from '../hermes/hermes-gateway-client.ts';
import {
  HermesCronsClient,
  HermesCronsError,
  type HermesCronJob,
  type HermesCronUpdatePayload,
} from './hermes-crons-client.ts';
import { CronDescriptionsStore, type CronDescription } from './cron-descriptions-store.ts';

// Path-segment guard for the run-history reader: no slashes, no dots,
// only safe identifier chars. Hermes typically emits 12-char lowercase
// hex but we don't lock to that exact shape in case it ever changes.
const VALID_JOB_ID = /^[A-Za-z0-9_-]+$/;

// Run output filenames are markdown produced by Hermes' scheduler. Allow
// alphanumerics, hyphen, underscore, period — and require .md.
const VALID_RUN_FILENAME = /^[A-Za-z0-9._-]+\.md$/;

export interface CronRunSummary {
  filename: string;
  ts: string;
  size: number;
  modified: string;
}

export interface CronTranscriptMessage {
  role: string;
  content: unknown;
  timestamp?: number | string | null;
}

export function buildCronsRoutes(hermes: HermesSupervisor, descriptions: CronDescriptionsStore): Route[] {
  // Hermes (in verso's managed mode) writes cron data under
  // <hermesHome>/cron/output/<jobId>/<timestamp>.md and session files under
  // <hermesHome>/sessions/. The supervisor exposes the active home so we
  // don't have to guess between ~/.hermes and ~/.hermes/profiles/<name>.
  const cronOutputDir = (): string => path.join(hermes.hermesHome, 'cron', 'output');
  const sessionsDir = (): string => path.join(hermes.hermesHome, 'sessions');

  return [
    route('GET', '/crons', async (_req, res) => {
      const jobs = await listJobs(hermes);
      json(res, 200, { crons: jobs });
    }),

    route('GET', '/crons/:id', async (_req, res, params) => {
      const id = params.id;
      if (!isValidJobId(id)) return notFound(res, id);
      const job = await getJob(hermes, id);
      if (!job) return notFound(res, id);
      const runs = listRuns(cronOutputDir(), id);
      const description = descriptions.get(id);
      json(res, 200, { cron: job, runs, description: serializeDescription(description) });
    }),

    route('GET', '/crons/:id/runs/:filename', async (_req, res, params) => {
      const id = params.id;
      const filename = params.filename;
      if (!isValidJobId(id)) return notFound(res, id);
      if (!VALID_RUN_FILENAME.test(filename)) {
        return json(res, 400, { error: 'bad_request', message: 'Invalid run filename' });
      }
      const root = cronOutputDir();
      const filePath = path.join(root, id, filename);
      const resolved = path.resolve(filePath);
      const rootResolved = path.resolve(root);
      if (!resolved.startsWith(rootResolved + path.sep)) {
        return json(res, 400, { error: 'bad_request', message: 'Invalid path' });
      }
      let content: string;
      try {
        content = readFileSync(resolved, 'utf-8');
      } catch {
        return json(res, 404, { error: 'not_found', message: 'Run output not found' });
      }
      json(res, 200, { filename, content });
    }),

    route('POST', '/crons/:id/description/generate', async (_req, res, params, body) => {
      const id = params.id;
      if (!isValidJobId(id)) return notFound(res, id);
      const client = await getClient(hermes);
      const job = await client.get(id);
      if (!job) return notFound(res, id);
      const force = !!(body && typeof body === 'object' && (body as Record<string, unknown>).force);
      const existing = descriptions.get(id);
      // User-edited descriptions are sticky — generation only overwrites when
      // explicitly forced, so a regenerate doesn't wipe what the user wrote.
      if (existing && existing.source === 'user' && !force) {
        return json(res, 200, { description: serializeDescription(existing) });
      }
      try {
        const generated = await generateDescriptionViaHermes(hermes, job);
        if (!generated) {
          return json(res, 502, { error: 'generation_failed', message: 'Hermes returned no summary' });
        }
        descriptions.set(id, generated, 'auto');
        json(res, 200, { description: serializeDescription(descriptions.get(id)) });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        json(res, 502, { error: 'generation_failed', message });
      }
    }),

    route('PATCH', '/crons/:id/description', async (_req, res, params, body) => {
      const id = params.id;
      if (!isValidJobId(id)) return notFound(res, id);
      const raw = body && typeof body === 'object'
        ? (body as Record<string, unknown>).description
        : undefined;
      if (typeof raw !== 'string') {
        return json(res, 400, { error: 'bad_request', message: 'Missing "description"' });
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        descriptions.delete(id);
        return json(res, 200, { description: null });
      }
      // 280 chars matches the LLM's hard ceiling — keep storage modest.
      const clipped = trimmed.length > 280 ? trimmed.slice(0, 280) : trimmed;
      descriptions.set(id, clipped, 'user');
      json(res, 200, { description: serializeDescription(descriptions.get(id)) });
    }),

    route('GET', '/crons/:id/runs/:filename/transcript', async (_req, res, params) => {
      const id = params.id;
      const filename = params.filename;
      if (!isValidJobId(id)) return notFound(res, id);
      if (!VALID_RUN_FILENAME.test(filename)) {
        return json(res, 400, { error: 'bad_request', message: 'Invalid run filename' });
      }
      const transcript = loadTranscriptForRun(cronOutputDir(), sessionsDir(), id, filename);
      if (!transcript) {
        return json(res, 404, { error: 'not_found', message: 'Transcript not available for this run' });
      }
      json(res, 200, transcript);
    }),

    route('PATCH', '/crons/:id', async (_req, res, params, body) => {
      const id = params.id;
      if (!isValidJobId(id)) return notFound(res, id);
      const payload = sanitizeUpdate(body);
      const client = await getClient(hermes);
      try {
        const job = await client.update(id, payload);
        if (!job) return notFound(res, id);
        json(res, 200, { cron: job });
      } catch (error: unknown) {
        forwardError(res, error);
      }
    }),

    route('DELETE', '/crons/:id', async (_req, res, params) => {
      const id = params.id;
      if (!isValidJobId(id)) return notFound(res, id);
      const client = await getClient(hermes);
      const ok = await client.remove(id);
      if (!ok) return notFound(res, id);
      // Clean up our local sidecar state too — otherwise a future job that
      // happens to receive the same id would inherit a stale description.
      descriptions.delete(id);
      json(res, 200, { ok: true });
    }),

    route('POST', '/crons/:id/pause', actionRoute(hermes, 'pause')),
    route('POST', '/crons/:id/resume', actionRoute(hermes, 'resume')),
    route('POST', '/crons/:id/run', actionRoute(hermes, 'run')),
  ];
}

function actionRoute(hermes: HermesSupervisor, op: 'pause' | 'resume' | 'run') {
  return async (_req: unknown, res: ServerResponse, params: Record<string, string>) => {
    const id = params.id;
    if (!isValidJobId(id)) return notFound(res, id);
    const client = await getClient(hermes);
    try {
      const job = op === 'pause'
        ? await client.pause(id)
        : op === 'resume'
          ? await client.resume(id)
          : await client.runNow(id);
      if (!job) return notFound(res, id);
      json(res, 200, { cron: job });
    } catch (error: unknown) {
      forwardError(res, error);
    }
  };
}

async function getClient(hermes: HermesSupervisor): Promise<HermesCronsClient> {
  const config = await hermes.ensureReady();
  return new HermesCronsClient(config.baseUrl, config.apiKey ?? undefined);
}

async function listJobs(hermes: HermesSupervisor): Promise<HermesCronJob[]> {
  try {
    return await (await getClient(hermes)).list();
  } catch (error: unknown) {
    const jobs = shouldFallbackToLocalJobs(error) ? readLocalCronJobs(hermes.hermesHome) : null;
    if (jobs) return jobs;
    throw error;
  }
}

async function getJob(hermes: HermesSupervisor, id: string): Promise<HermesCronJob | null> {
  try {
    return await (await getClient(hermes)).get(id);
  } catch (error: unknown) {
    const jobs = shouldFallbackToLocalJobs(error) ? readLocalCronJobs(hermes.hermesHome) : null;
    if (jobs) return jobs.find((job) => job.id === id) ?? null;
    throw error;
  }
}

function shouldFallbackToLocalJobs(error: unknown): boolean {
  return !(error instanceof HermesCronsError);
}

function isValidJobId(id: string): boolean {
  return VALID_JOB_ID.test(id);
}

function notFound(res: ServerResponse, id: string): void {
  json(res, 404, { error: 'not_found', message: `Unknown cron job: ${id}` });
}

function forwardError(res: ServerResponse, error: unknown): void {
  if (error instanceof HermesCronsError) {
    // Surface Hermes' own message so schedule-parse errors etc. land in the UI.
    json(res, error.status >= 400 && error.status < 500 ? error.status : 502, {
      error: 'hermes_error',
      status: error.status,
      message: error.body || error.message,
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function sanitizeUpdate(body: unknown): HermesCronUpdatePayload {
  if (!body || typeof body !== 'object') return {};
  const src = body as Record<string, unknown>;
  const out: HermesCronUpdatePayload = {};
  for (const key of ['name', 'schedule', 'prompt', 'deliver'] as const) {
    if (typeof src[key] === 'string') out[key] = src[key] as string;
  }
  if (Array.isArray(src.skills)) {
    out.skills = (src.skills as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  if (src.repeat && typeof src.repeat === 'object') {
    const repeat = src.repeat as Record<string, unknown>;
    out.repeat = {
      times: typeof repeat.times === 'number' ? repeat.times : null,
    };
  }
  return out;
}

function readLocalCronJobs(hermesHome: string): HermesCronJob[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(hermesHome, 'cron', 'jobs.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rawJobs = (parsed as Record<string, unknown>).jobs;
  if (!Array.isArray(rawJobs)) return null;
  return rawJobs
    .map((raw) => normalizeLocalCronJob(raw))
    .filter((job): job is HermesCronJob => job !== null);
}

function normalizeLocalCronJob(raw: unknown): HermesCronJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = asString(obj.id);
  const name = asString(obj.name);
  if (!id || !name) return null;
  const schedule = obj.schedule && typeof obj.schedule === 'object'
    ? obj.schedule as HermesCronJob['schedule']
    : {};
  return {
    ...obj,
    id,
    name,
    prompt: asString(obj.prompt) ?? '',
    skills: Array.isArray(obj.skills) ? obj.skills.filter((skill): skill is string => typeof skill === 'string') : [],
    schedule,
    schedule_display: asString(obj.schedule_display) ?? asString(schedule.display) ?? undefined,
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    state: asString(obj.state) ?? (obj.enabled === false ? 'paused' : 'scheduled'),
    paused_at: asString(obj.paused_at),
    paused_reason: asString(obj.paused_reason),
    created_at: asString(obj.created_at) ?? '',
    next_run_at: asString(obj.next_run_at),
    last_run_at: asString(obj.last_run_at),
    last_status: asString(obj.last_status),
    last_error: asString(obj.last_error),
    running: obj.running === true,
    deliver: asString(obj.deliver),
    origin: obj.origin && typeof obj.origin === 'object' ? obj.origin as Record<string, unknown> : null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function listRuns(outputRoot: string, jobId: string): CronRunSummary[] {
  const dir = path.join(outputRoot, jobId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CronRunSummary[] = [];
  for (const filename of entries) {
    if (!VALID_RUN_FILENAME.test(filename)) continue;
    let info;
    try {
      info = statSync(path.join(dir, filename));
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    out.push({
      filename,
      ts: filename.replace(/\.md$/, ''),
      size: info.size,
      modified: info.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

// Cron run files are named by the run *end* time (`2026-05-08_12-10-46.md`)
// while Hermes session files are named by the run *start* time
// (`session_cron_<jobId>_20260508_120519.json`). To pair them, we list both
// in chronological order and match nth-oldest file with nth-oldest session
// for the same job — robust as long as runs don't overlap (the scheduler
// runs them sequentially, so they don't).
function loadTranscriptForRun(
  outputRoot: string,
  sessionsRoot: string,
  jobId: string,
  filename: string,
): { sessionId: string; messages: CronTranscriptMessage[] } | null {
  const runs = listRuns(outputRoot, jobId).slice().reverse(); // oldest first
  const idx = runs.findIndex((r) => r.filename === filename);
  if (idx < 0) return null;

  const sessions = listCronSessionsForJob(sessionsRoot, jobId);
  if (idx >= sessions.length) return null;
  const sessionFile = sessions[idx];
  return readSessionTranscript(sessionsRoot, sessionFile);
}

function listCronSessionsForJob(sessionsRoot: string, jobId: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  const prefix = `session_cron_${jobId}_`;
  return entries
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort(); // lexicographic == chronological for YYYYMMDD_HHMMSS
}

function readSessionTranscript(
  sessionsRoot: string,
  filename: string,
): { sessionId: string; messages: CronTranscriptMessage[] } | null {
  const filePath = path.join(sessionsRoot, filename);
  const resolved = path.resolve(filePath);
  const root = path.resolve(sessionsRoot);
  if (!resolved.startsWith(root + path.sep)) return null;
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const sessionId = typeof obj.session_id === 'string'
    ? obj.session_id
    : filename.replace(/^session_/, '').replace(/\.json$/, '');
  const messagesRaw = obj.messages;
  if (!Array.isArray(messagesRaw)) return { sessionId, messages: [] };
  const messages: CronTranscriptMessage[] = messagesRaw
    .map((m) => normalizeTranscriptMessage(m))
    .filter((m): m is CronTranscriptMessage => m !== null);
  return { sessionId, messages };
}

function normalizeTranscriptMessage(raw: unknown): CronTranscriptMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const role = typeof obj.role === 'string' ? obj.role : null;
  if (!role) return null;
  const content = obj.content ?? null;
  const timestamp = typeof obj.timestamp === 'number' || typeof obj.timestamp === 'string'
    ? obj.timestamp
    : null;
  return { role, content, timestamp };
}

function serializeDescription(description: CronDescription | null): {
  text: string;
  source: 'auto' | 'user';
  generatedAt: number;
} | null {
  if (!description) return null;
  return {
    text: description.description,
    source: description.source,
    generatedAt: description.generatedAt,
  };
}

const DESCRIPTION_PROMPT = (name: string, prompt: string): string => (
  `You are summarising a scheduled automation routine for a UI subtitle.\n\n`
  + `Name: ${name}\n`
  + `Prompt: ${truncateForPrompt(prompt, 1800)}\n\n`
  + `Write a single sentence (12–20 words) describing what the routine does and its outcome — `
  + `e.g. "Sends a daily 12:00 PM email summarising today's calendar with prep notes from Slack and Granola."\n`
  + `Respond with the sentence only — no quotes, no preamble, no trailing punctuation other than a period.`
);

const HERMES_DESCRIPTION_TIMEOUT_MS = 20_000;

async function generateDescriptionViaHermes(
  hermes: HermesSupervisor,
  job: HermesCronJob,
): Promise<string | null> {
  const config = await hermes.ensureReady();
  const raw = await hermesOneShotText(config, DESCRIPTION_PROMPT(job.name, job.prompt), HERMES_DESCRIPTION_TIMEOUT_MS);
  return sanitizeDescription(raw);
}

function truncateForPrompt(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}…`;
}

function sanitizeDescription(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const stripped = collapsed.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  if (!stripped) return null;
  // Cap at 280 chars to keep the UI subtitle compact even if the model rambles.
  return stripped.length > 280 ? stripped.slice(0, 280).trimEnd() + '…' : stripped;
}
