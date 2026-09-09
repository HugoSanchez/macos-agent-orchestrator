import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic, writeTextFileAtomic } from '../shared/atomic-json-file.ts';

const MAX_NAME_CHARS = 80;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_READ_BYTES = 10 * 1024 * 1024;

const EDITABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.html', '.css', '.js', '.ts', '.tsx',
  '.json', '.csv', '.yaml', '.yml', '.xml',
]);

const READABLE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx']);

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type WorkspaceIndexStatus = 'ready' | 'unsupported' | 'error' | 'indexing';

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  size?: number;
  mimeType?: string;
  editable: boolean;
  indexStatus?: WorkspaceIndexStatus;
}

interface WorkspaceState {
  version: 1;
  workspaces: WorkspaceRecord[];
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

/** Metadata plus safe access to the real files that form each workspace. */
export class WorkspaceStore {
  private readonly statePath: string;
  private state: WorkspaceState;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.statePath = path.join(root, 'workspaces.json');
    this.state = readJsonFileOr(this.statePath, decodeState, () => ({ version: 1, workspaces: [] }));
    for (const workspace of this.state.workspaces) mkdirSync(this.directory(workspace.id), { recursive: true });
  }

  list(): WorkspaceRecord[] {
    return [...this.state.workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): WorkspaceRecord | null {
    return this.state.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  create(name: string): WorkspaceRecord {
    const cleanName = validateWorkspaceName(name);
    if (this.state.workspaces.some((workspace) => workspace.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      throw new WorkspaceError('A workspace with that name already exists.', 409);
    }
    const now = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: cleanName,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    mkdirSync(this.directory(workspace.id), { recursive: true });
    this.state.workspaces.push(workspace);
    this.persist();
    return workspace;
  }

  rename(id: string, name: string): WorkspaceRecord {
    const workspace = this.require(id);
    const cleanName = validateWorkspaceName(name);
    if (this.state.workspaces.some((candidate) => (
      candidate.id !== id && candidate.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase()
    ))) {
      throw new WorkspaceError('A workspace with that name already exists.', 409);
    }
    workspace.name = cleanName;
    return this.touch(id);
  }

  touch(id: string): WorkspaceRecord {
    const workspace = this.require(id);
    workspace.updatedAt = new Date().toISOString();
    workspace.revision += 1;
    this.persist();
    return workspace;
  }

  directory(id: string): string {
    return path.join(this.root, id);
  }

  listEntries(id: string): WorkspaceEntry[] {
    this.require(id);
    const root = this.directory(id);
    const entries: WorkspaceEntry[] = [];
    const visit = (directory: string, relativeParent: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name === '.DS_Store' || item.isSymbolicLink()) continue;
        const relativePath = relativeParent ? `${relativeParent}/${item.name}` : item.name;
        const absolutePath = path.join(directory, item.name);
        if (item.isDirectory()) {
          entries.push({ path: relativePath, name: item.name, kind: 'folder', editable: false });
          visit(absolutePath, relativePath);
        } else if (item.isFile()) {
          const size = statSync(absolutePath).size;
          entries.push({
            path: relativePath,
            name: item.name,
            kind: 'file',
            size,
            mimeType: mimeTypeFor(relativePath),
            editable: isEditable(relativePath) && size <= MAX_EDITABLE_BYTES,
          });
        }
      }
    };
    visit(root, '');
    return entries;
  }

  createFolder(id: string, relativePath: string): WorkspaceRecord {
    const target = this.resolve(id, relativePath);
    if (existsSync(target)) throw new WorkspaceError('A file or folder already exists at that path.', 409);
    mkdirSync(target, { recursive: true });
    return this.touch(id);
  }

  moveEntry(id: string, relativePath: string, destinationPath: string): WorkspaceRecord {
    const source = this.resolve(id, relativePath);
    if (!existsSync(source)) throw new WorkspaceError('File or folder not found.', 404);
    const destination = this.resolve(id, destinationPath);
    if (existsSync(destination)) throw new WorkspaceError('A file or folder already exists at that path.', 409);
    if (destination.startsWith(`${source}${path.sep}`)) {
      throw new WorkspaceError('A folder cannot be moved inside itself.');
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(source, destination);
    return this.touch(id);
  }

  deleteEntry(id: string, relativePath: string): WorkspaceRecord {
    const target = this.resolve(id, relativePath);
    if (!existsSync(target)) throw new WorkspaceError('File or folder not found.', 404);
    rmSync(target, { recursive: true, force: false });
    return this.touch(id);
  }

  writeText(id: string, relativePath: string, content: string): WorkspaceRecord {
    if (!isEditable(relativePath)) throw new WorkspaceError('That file type is not editable in Verso.', 415);
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new WorkspaceError('The file is too large to edit in Verso.', 413);
    }
    const target = this.resolve(id, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeTextFileAtomic(target, content);
    return this.touch(id);
  }

  createText(id: string, relativePath: string, content: string): WorkspaceRecord {
    const target = this.resolve(id, relativePath);
    if (existsSync(target)) throw new WorkspaceError('A file or folder already exists at that path.', 409);
    return this.writeText(id, relativePath, content);
  }

  readText(id: string, relativePath: string): {
    path: string;
    content: string;
    mimeType: string;
    editable: true;
  } {
    const target = this.resolve(id, relativePath);
    if (!existsSync(target)) throw new WorkspaceError('File not found.', 404);
    const fileStat = statSync(target);
    if (!fileStat.isFile()) throw new WorkspaceError('File not found.', 404);
    if (!isEditable(relativePath) || fileStat.size > MAX_EDITABLE_BYTES) {
      throw new WorkspaceError('That file cannot be edited as text in Verso.', 415);
    }
    return {
      path: normalizeRelativePath(relativePath),
      content: readFileSync(target, 'utf8'),
      mimeType: mimeTypeFor(relativePath),
      editable: true,
    };
  }

  /** Read an imported workspace file for the chat attachment pipeline. */
  readAttachment(id: string, relativePath: string): {
    path: string;
    content: Buffer;
    mimeType: string;
  } {
    const target = this.absoluteFilePath(id, relativePath);
    if (statSync(target).size > MAX_ATTACHMENT_READ_BYTES) {
      throw new WorkspaceError('That file is too large to attach to a chat message.', 413);
    }
    return {
      path: normalizeRelativePath(relativePath),
      content: readFileSync(target),
      mimeType: mimeTypeFor(relativePath),
    };
  }

  importFiles(id: string, sourcePaths: string[]): { workspace: WorkspaceRecord; imported: string[] } {
    this.require(id);
    if (sourcePaths.length === 0) throw new WorkspaceError('Choose at least one file to import.');
    const workspaceDirectory = this.directory(id);
    const reservedNames = new Set(readdirSync(workspaceDirectory).map((name) => name.toLocaleLowerCase()));
    const imports = sourcePaths.map((sourcePath) => {
      if (!path.isAbsolute(sourcePath) || !existsSync(sourcePath)) throw new WorkspaceError('An imported file does not exist.');
      const sourceStat = statSync(sourcePath);
      if (!sourceStat.isFile()) throw new WorkspaceError('Only individual files can be imported for now.');
      if (sourceStat.size > MAX_IMPORT_BYTES) throw new WorkspaceError(`${path.basename(sourcePath)} is too large to import.`, 413);
      const destinationName = availableName(workspaceDirectory, path.basename(sourcePath), reservedNames);
      reservedNames.add(destinationName.toLocaleLowerCase());
      return { sourcePath, destinationName };
    });

    const imported: string[] = [];
    try {
      for (const item of imports) {
        copyFileSync(item.sourcePath, path.join(workspaceDirectory, item.destinationName));
        imported.push(item.destinationName);
      }
    } catch (error) {
      for (const name of imported) rmSync(path.join(workspaceDirectory, name), { force: true });
      throw error;
    }
    return { workspace: this.touch(id), imported };
  }

  absoluteFilePath(id: string, relativePath: string): string {
    const target = this.resolve(id, relativePath);
    if (!existsSync(target)) throw new WorkspaceError('File not found.', 404);
    if (!statSync(target).isFile()) throw new WorkspaceError('File not found.', 404);
    return target;
  }

  private require(id: string): WorkspaceRecord {
    const workspace = this.get(id);
    if (!workspace) throw new WorkspaceError('Workspace not found.', 404);
    return workspace;
  }

  private resolve(id: string, relativePath: string): string {
    this.require(id);
    const normalized = normalizeRelativePath(relativePath);
    const root = this.directory(id);
    const target = path.resolve(root, ...normalized.split('/'));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new WorkspaceError('Invalid workspace path.');

    let cursor = path.dirname(target);
    while (cursor.startsWith(`${root}${path.sep}`)) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new WorkspaceError('Symbolic links are not supported.');
      cursor = path.dirname(cursor);
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new WorkspaceError('Symbolic links are not supported.');
    return target;
  }

  private persist(): void {
    writeJsonFileAtomic(this.statePath, this.state);
  }
}

export function isEditable(relativePath: string): boolean {
  return EDITABLE_EXTENSIONS.has(path.extname(relativePath).toLocaleLowerCase());
}

/** Documents whose converted Markdown can be read through the workspace API. */
export function isReadableDocument(relativePath: string): boolean {
  return READABLE_DOCUMENT_EXTENSIONS.has(path.extname(relativePath).toLocaleLowerCase());
}

export function mimeTypeFor(relativePath: string): string {
  switch (path.extname(relativePath).toLocaleLowerCase()) {
    case '.md': case '.markdown': return 'text/markdown';
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.js': return 'text/javascript';
    case '.json': return 'application/json';
    case '.csv': return 'text/csv';
    case '.yaml': case '.yml': return 'application/yaml';
    case '.xml': return 'application/xml';
    case '.pdf': return 'application/pdf';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default: return 'text/plain';
  }
}

function validateWorkspaceName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new WorkspaceError('Workspace name is required.');
  if (clean.length > MAX_NAME_CHARS) throw new WorkspaceError(`Workspace names can be at most ${MAX_NAME_CHARS} characters.`);
  return clean;
}

function normalizeRelativePath(value: string): string {
  const clean = value.trim().replaceAll('\\', '/');
  if (!clean || clean.startsWith('/') || clean.includes('\0')) throw new WorkspaceError('Invalid workspace path.');
  const parts = clean.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new WorkspaceError('Invalid workspace path.');
  return parts.join('/');
}

function availableName(directory: string, requested: string, reservedNames = new Set<string>()): string {
  const extension = path.extname(requested);
  const stem = path.basename(requested, extension);
  let candidate = requested;
  let suffix = 2;
  while (reservedNames.has(candidate.toLocaleLowerCase()) || existsSync(path.join(directory, candidate))) {
    candidate = `${stem} ${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

function decodeState(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: 1, workspaces: [] };
  const candidate = value as { version?: unknown; workspaces?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.workspaces)) return { version: 1, workspaces: [] };
  return {
    version: 1,
    workspaces: candidate.workspaces.filter(isWorkspaceRecord),
  };
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<WorkspaceRecord>;
  return typeof item.id === 'string'
    && /^[0-9a-f-]{36}$/i.test(item.id)
    && typeof item.name === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string'
    && typeof item.revision === 'number';
}
