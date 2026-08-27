import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, route, type Route } from '../http/router.ts';
import { ALWAYS_DISABLED_HERMES_SKILLS } from '../hermes/hermes-supervisor.ts';
import type { HermesSkillsConfig } from './skills-store.ts';
import type { PinnedSkillsStore } from './pinned-skills-store.ts';

const HIDDEN_SKILL_NAMES = new Set<string>(ALWAYS_DISABLED_HERMES_SKILLS);

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  prerequisites: string[];
  platforms: string[];
  enabled: boolean;
  pinned: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  frontmatter: Record<string, unknown>;
  path: string;
}

interface ParsedSkill {
  slug: string;
  name: string;
  category: string | null;
  path: string;
  dirPath: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

// The skills directory is set at startup by `setSkillsDir()`, called from
// the HTTP server bootstrap once HermesSupervisor has resolved which Hermes
// home is active (profile-aware vs legacy). The default below is only a
// fallback for tests/tools that import this module without going through the
// server entrypoint.
let skillsDirPath = path.join(os.homedir(), '.hermes', 'skills');

export function setSkillsDir(dir: string): void {
  skillsDirPath = dir;
}

function currentSkillsDir(): string {
  return skillsDirPath;
}

export function buildSkillsRoutes(config: HermesSkillsConfig, pins: PinnedSkillsStore): Route[] {
  return [
    route('GET', '/skills', async (_req, res) => {
      const skills = scanSkills()
        .filter((skill) => !HIDDEN_SKILL_NAMES.has(skill.name))
        .map((skill) =>
          toSummary(skill, config.isEnabled(skill.name), pins.isPinned(skill.name)),
        );
      json(res, 200, { skills });
    }),

    route('GET', '/skills/:slug', async (_req, res, params) => {
      const skill = findSkillBySlug(params.slug);
      if (!skill || HIDDEN_SKILL_NAMES.has(skill.name)) {
        return json(res, 404, { error: 'not_found', message: `Unknown skill: ${params.slug}` });
      }
      json(res, 200, {
        skill: toDetail(skill, config.isEnabled(skill.name), pins.isPinned(skill.name)),
      });
    }),

    route('POST', '/skills/:slug/toggle', async (_req, res, params, body) => {
      const skill = findSkillBySlug(params.slug);
      if (!skill || HIDDEN_SKILL_NAMES.has(skill.name)) {
        return json(res, 404, { error: 'not_found', message: `Unknown skill: ${params.slug}` });
      }
      const requested = (body as { enabled?: unknown } | null)?.enabled;
      const next = typeof requested === 'boolean' ? requested : !config.isEnabled(skill.name);
      config.setEnabled(skill.name, next);
      json(res, 200, { skill: toSummary(skill, next, pins.isPinned(skill.name)) });
    }),

    route('POST', '/skills/:slug/pin', async (_req, res, params, body) => {
      const skill = findSkillBySlug(params.slug);
      if (!skill) {
        return json(res, 404, { error: 'not_found', message: `Unknown skill: ${params.slug}` });
      }
      const requested = (body as { pinned?: unknown } | null)?.pinned;
      const next = typeof requested === 'boolean' ? requested : !pins.isPinned(skill.name);
      pins.setPinned(skill.name, next);
      json(res, 200, { skill: toSummary(skill, config.isEnabled(skill.name), next) });
    }),
  ];
}

export function findSkillBySlug(slug: string): ParsedSkill | null {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;
  return scanSkills().find((candidate) => candidate.slug === normalized) ?? null;
}

// Mirrors ~/.hermes/hermes-agent/agent/skill_commands.py:build_skill_invocation_message
// so the message Hermes' agent sees from our /v1/responses path is shaped the
// same as the messages other Hermes platforms (CLI, gateway, webhook) build for
// the same /skill-name flow. Hermes' api_server.py does not run this rewrite;
// we are the gateway-equivalent for the HTTP path.
export function buildSkillInvocationPrompt(
  skill: ParsedSkill,
  userInstruction: string,
  sessionId: string | null,
): string {
  const body = substituteTemplateVars(skill.content.trim(), skill.dirPath, sessionId);
  const parts: string[] = [
    `[SYSTEM: The user has invoked the "${skill.name}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]`,
    '',
    body,
  ];

  parts.push(
    '',
    `[Skill directory: ${skill.dirPath}]`,
    'Resolve any relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against that directory, then run them with the terminal tool using the absolute path.',
  );

  const supporting = collectSupportingFiles(skill.dirPath);
  if (supporting.length > 0) {
    const skillViewTarget = skillViewTargetForDir(skill.dirPath);
    parts.push('', '[This skill has supporting files:]');
    for (const rel of supporting) {
      parts.push(`- ${rel}  ->  ${path.join(skill.dirPath, rel)}`);
    }
    parts.push(
      `\nLoad any of these with skill_view(name="${skillViewTarget}", file_path="<path>"), or run scripts directly by absolute path (e.g. \`node ${skill.dirPath}/scripts/foo.js\`).`,
    );
  }

  const trimmedInstruction = userInstruction.trim();
  if (trimmedInstruction.length > 0) {
    parts.push('', `The user has provided the following instruction alongside the skill invocation: ${trimmedInstruction}`);
  }

  return parts.join('\n');
}

const SLASH_SKILL_PATTERN = /^\/([a-z0-9][a-z0-9_-]*)\b/i;

export function extractSlashSkillRequest(input: string): { slug: string; remainder: string } | null {
  const match = input.match(SLASH_SKILL_PATTERN);
  if (!match) return null;
  // Hermes treats - and _ interchangeably (resolve_skill_command_key).
  const slug = normalizeSlug(match[1]);
  if (!slug) return null;
  const remainder = input.slice(match[0].length).trim();
  return { slug, remainder };
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scanSkills(): ParsedSkill[] {
  return walk(currentSkillsDir())
    .map((filePath) => parseSkillFile(filePath))
    .filter((skill): skill is ParsedSkill => skill !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function walk(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry === '.git' || entry === '.github' || entry === '.hub') continue;
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      found.push(...walk(full));
    } else if (info.isFile() && entry === 'SKILL.md') {
      found.push(full);
    }
  }
  return found;
}

function parseSkillFile(filePath: string): ParsedSkill | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const dirPath = path.dirname(filePath);
  const nameField = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const name = nameField || path.basename(dirPath);
  if (!name) return null;
  const slug = normalizeSlug(name);
  if (!slug) return null;
  const category = inferCategory(filePath);
  return { slug, name, category, path: filePath, dirPath, frontmatter, content: body };
}

function inferCategory(filePath: string): string | null {
  const relative = path.relative(currentSkillsDir(), path.dirname(filePath));
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length <= 1) return null;
  return segments[0] || null;
}

const TEMPLATE_VAR_RE = /\$\{(HERMES_SKILL_DIR|HERMES_SESSION_ID)\}/g;

function substituteTemplateVars(content: string, skillDir: string | null, sessionId: string | null): string {
  if (!content) return content;
  return content.replace(TEMPLATE_VAR_RE, (match, token: string) => {
    if (token === 'HERMES_SKILL_DIR' && skillDir) return skillDir;
    if (token === 'HERMES_SESSION_ID' && sessionId) return sessionId;
    return match;
  });
}

const SUPPORTING_DIRS = ['references', 'templates', 'scripts', 'assets'];

function collectSupportingFiles(skillDir: string): string[] {
  const out: string[] = [];
  for (const sub of SUPPORTING_DIRS) {
    const subPath = path.join(skillDir, sub);
    let stat;
    try {
      stat = statSync(subPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    walkFiles(subPath, skillDir, out);
  }
  return out.sort();
}

function walkFiles(dir: string, baseDir: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      walkFiles(full, baseDir, out);
    } else if (info.isFile()) {
      out.push(path.relative(baseDir, full));
    }
  }
}

function skillViewTargetForDir(skillDir: string): string {
  const rel = path.relative(currentSkillsDir(), skillDir);
  if (!rel || rel.startsWith('..')) {
    return path.basename(skillDir);
  }
  return rel;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) {
    return { frontmatter: {}, body: raw };
  }
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = input.split(/\r?\n/);
  const stack: { indent: number; container: Record<string, unknown> | unknown[] }[] = [{ indent: -1, container: result }];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (Array.isArray(top.container)) {
        top.container.push(parseScalar(trimmed.slice(2).trim()));
      }
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const valueStr = trimmed.slice(colon + 1).trim();

    if (!Array.isArray(top.container)) {
      if (!valueStr) {
        const next = lines.slice(i + 1).find((candidate) => candidate.trim().length > 0);
        const nextIndent = next ? next.match(/^\s*/)?.[0].length ?? 0 : indent + 2;
        if (next && next.trim().startsWith('- ') && nextIndent > indent) {
          const arr: unknown[] = [];
          top.container[key] = arr;
          stack.push({ indent, container: arr });
        } else {
          const obj: Record<string, unknown> = {};
          top.container[key] = obj;
          stack.push({ indent, container: obj });
        }
      } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
        top.container[key] = valueStr
          .slice(1, -1)
          .split(',')
          .map((item) => parseScalar(item.trim()))
          .filter((item) => item !== '');
      } else {
        top.container[key] = parseScalar(valueStr);
      }
    }
  }

  return result;
}

function parseScalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const stripped = value.replace(/^['"]|['"]$/g, '');
  const asNumber = Number(stripped);
  if (!Number.isNaN(asNumber) && /^-?\d+(\.\d+)?$/.test(stripped)) return asNumber;
  return stripped;
}

function toSummary(skill: ParsedSkill, enabled: boolean, pinned: boolean): SkillSummary {
  const fm = skill.frontmatter;
  return {
    slug: skill.slug,
    name: typeof fm.name === 'string' ? (fm.name as string) : skill.name,
    description: typeof fm.description === 'string' ? (fm.description as string) : '',
    category: skill.category,
    tags: extractTags(fm),
    prerequisites: extractPrerequisites(fm),
    platforms: extractStringArray(fm.platforms),
    enabled,
    pinned,
  };
}

function toDetail(skill: ParsedSkill, enabled: boolean, pinned: boolean): SkillDetail {
  return {
    ...toSummary(skill, enabled, pinned),
    content: skill.content,
    frontmatter: skill.frontmatter,
    path: skill.path,
  };
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const meta = frontmatter.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const hermes = (meta as Record<string, unknown>).hermes;
    if (hermes && typeof hermes === 'object' && !Array.isArray(hermes)) {
      return extractStringArray((hermes as Record<string, unknown>).tags);
    }
  }
  return [];
}

function extractPrerequisites(frontmatter: Record<string, unknown>): string[] {
  const prereq = frontmatter.prerequisites;
  if (prereq && typeof prereq === 'object' && !Array.isArray(prereq)) {
    return extractStringArray((prereq as Record<string, unknown>).commands);
  }
  return [];
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}
