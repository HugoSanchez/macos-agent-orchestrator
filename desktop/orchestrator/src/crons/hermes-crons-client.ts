// Thin client over Hermes' native cron CRUD at /api/jobs.
//
// Hermes' gateway exposes the same endpoints used by the `hermes cron` CLI
// and the agent-facing `cronjob` tool, so we don't keep any cron state in
// verso — we just proxy.
//
// Auth: if API_SERVER_KEY is configured on the gateway side, every request
// must carry `Authorization: Bearer <key>`. We pick that key up from the
// process env (Hermes' own convention), so locally it just works without
// configuration.

export interface HermesCronSchedule {
  kind?: string;
  display?: string;
  expr?: string;
  minutes?: number;
  run_at?: string;
  [key: string]: unknown;
}

export interface HermesCronJob {
  id: string;
  name: string;
  prompt: string;
  skills: string[];
  skill?: string | null;
  model?: string | null;
  provider?: string | null;
  base_url?: string | null;
  script?: string | null;
  schedule: HermesCronSchedule;
  schedule_display?: string;
  repeat?: { times: number | null; completed: number };
  enabled: boolean;
  state: string;
  /** True only while Hermes' scheduler is actively executing this job. */
  running?: boolean;
  paused_at?: string | null;
  paused_reason?: string | null;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_delivery_error?: string | null;
  deliver?: string | null;
  origin?: Record<string, unknown> | null;
  enabled_toolsets?: string[] | null;
  [key: string]: unknown;
}

export interface HermesCronUpdatePayload {
  name?: string;
  schedule?: string;
  prompt?: string;
  deliver?: string;
  skills?: string[];
  repeat?: { times?: number | null };
  [key: string]: unknown;
}

export class HermesCronsError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'HermesCronsError';
    this.status = status;
    this.body = body;
  }
}

export class HermesCronsClient {
  private readonly authHeader?: string;

  constructor(private readonly baseUrl: string, apiKey?: string) {
    const key = (apiKey ?? process.env.API_SERVER_KEY)?.trim();
    this.authHeader = key ? `Bearer ${key}` : undefined;
  }

  async list(opts: { includeDisabled?: boolean } = {}): Promise<HermesCronJob[]> {
    const qs = opts.includeDisabled === false ? '' : '?include_disabled=true';
    const res = await this.fetch(`/api/jobs${qs}`);
    if (res === null) return [];
    const body = await res.json() as { jobs?: HermesCronJob[] };
    return Array.isArray(body.jobs) ? body.jobs : [];
  }

  async get(jobId: string): Promise<HermesCronJob | null> {
    const res = await this.fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { allow404: true });
    if (res === null) return null;
    const body = await res.json() as { job?: HermesCronJob };
    return body.job ?? null;
  }

  async update(jobId: string, payload: HermesCronUpdatePayload): Promise<HermesCronJob | null> {
    const res = await this.fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body: payload,
      allow404: true,
    });
    if (res === null) return null;
    const body = await res.json() as { job?: HermesCronJob };
    return body.job ?? null;
  }

  async remove(jobId: string): Promise<boolean> {
    const res = await this.fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      allow404: true,
    });
    return res !== null;
  }

  async pause(jobId: string): Promise<HermesCronJob | null> {
    return this.action(jobId, 'pause');
  }

  async resume(jobId: string): Promise<HermesCronJob | null> {
    return this.action(jobId, 'resume');
  }

  async runNow(jobId: string): Promise<HermesCronJob | null> {
    return this.action(jobId, 'run');
  }

  private async action(jobId: string, op: 'pause' | 'resume' | 'run'): Promise<HermesCronJob | null> {
    const res = await this.fetch(`/api/jobs/${encodeURIComponent(jobId)}/${op}`, {
      method: 'POST',
      allow404: true,
    });
    if (res === null) return null;
    const body = await res.json() as { job?: HermesCronJob };
    return body.job ?? null;
  }

  private async fetch(
    path: string,
    opts: { method?: string; body?: unknown; allow404?: boolean } = {},
  ): Promise<Response | null> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.authHeader) headers['Authorization'] = this.authHeader;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (opts.allow404 && res.status === 404) return null;
    if (!res.ok) {
      const body = await readBodyText(res);
      throw new HermesCronsError(
        res.status,
        body,
        `Hermes cron API failed (HTTP ${res.status})${body ? `: ${body}` : ''}`,
      );
    }
    return res;
  }
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
