// Sidecar API client for the workspaces feature (orchestrator
// `src/workspaces/workspace-routes.ts`). Components never call these
// directly — `useWorkspacePanel` owns panel transport and state. InputBar
// only uses the attachment reader for a file explicitly dragged into chat.

import { baseURL, jsonInit, requestJson, sidecarFetch } from './chat';

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type WorkspaceIndexStatus = 'ready' | 'unsupported' | 'error' | 'indexing';

export interface WorkspaceEntryView {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  size?: number;
  mimeType?: string;
  editable: boolean;
  indexStatus?: WorkspaceIndexStatus;
}

export interface WorkspaceTextFileView {
  path: string;
  content: string;
  mimeType: string;
  editable: boolean;
}

export interface WorkspaceTreeView {
  workspace: WorkspaceSummary;
  entries: WorkspaceEntryView[];
}

export interface WorkspaceWriteResult {
  workspace: WorkspaceSummary;
  file: WorkspaceTextFileView;
}

export async function getWorkspaces(): Promise<WorkspaceSummary[]> {
  const body = await requestJson<{ workspaces: WorkspaceSummary[] }>(
    '/workspaces',
    'Failed to load workspaces',
  );
  return Array.isArray(body.workspaces) ? body.workspaces : [];
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const body = await requestJson<{ workspace: WorkspaceSummary }>(
    '/workspaces',
    'Failed to create workspace',
    jsonInit('POST', { name }),
  );
  return body.workspace;
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary> {
  const body = await requestJson<{ workspace: WorkspaceSummary }>(
    `/workspaces/${encodeURIComponent(id)}`,
    'Failed to rename workspace',
    jsonInit('PATCH', { name }),
  );
  return body.workspace;
}

export async function getWorkspaceTree(id: string): Promise<WorkspaceTreeView> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/tree`,
    'Failed to load workspace files',
  );
}

export async function importWorkspaceFiles(id: string, sourcePaths: string[]): Promise<WorkspaceTreeView> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/import`,
    'Failed to import files',
    jsonInit('POST', { sourcePaths }),
  );
}

export async function createWorkspaceFolder(id: string, path: string): Promise<WorkspaceTreeView> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/folders`,
    'Failed to create folder',
    jsonInit('POST', { path }),
  );
}

export async function moveWorkspaceEntry(
  id: string,
  path: string,
  destinationPath: string,
): Promise<WorkspaceTreeView> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/entry`,
    'Failed to move entry',
    jsonInit('PATCH', { path, destinationPath }),
  );
}

export async function deleteWorkspaceEntry(id: string, path: string): Promise<WorkspaceTreeView> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/entry?path=${encodeURIComponent(path)}`,
    'Failed to delete entry',
    { method: 'DELETE' },
  );
}

export async function getWorkspaceFile(id: string, path: string): Promise<WorkspaceTextFileView> {
  const body = await requestJson<{ file: WorkspaceTextFileView }>(
    `/workspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    'Failed to read file',
  );
  return body.file;
}

/** Load a workspace file as a browser File so chat uses its normal attachment path. */
export async function getWorkspaceAttachment(id: string, path: string): Promise<File> {
  const response = await sidecarFetch(
    `${baseURL()}/workspaces/${encodeURIComponent(id)}/attachment?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new Error(typeof body?.message === 'string' ? body.message : 'Failed to read workspace file');
  }
  const name = path.split('/').pop() || 'workspace-file';
  const type = response.headers.get('content-type') || '';
  return new File([await response.blob()], name, { type });
}

export async function createWorkspaceFile(
  id: string,
  path: string,
  content: string,
): Promise<WorkspaceWriteResult> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/file`,
    'Failed to create file',
    jsonInit('POST', { path, content }),
  );
}

export async function writeWorkspaceFile(
  id: string,
  path: string,
  content: string,
): Promise<WorkspaceWriteResult> {
  return requestJson(
    `/workspaces/${encodeURIComponent(id)}/file`,
    'Failed to save file',
    jsonInit('PUT', { path, content }),
  );
}
