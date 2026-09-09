export const WORKSPACE_FILE_DRAG_TYPE = 'application/x-verso-workspace-file';

export interface WorkspaceFileDragPayload {
  workspaceId: string;
  path: string;
}

export function isWorkspaceFileDrag(dataTransfer: Pick<DataTransfer, 'types'> | null): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_TYPE);
}

export function writeWorkspaceFileDrag(
  dataTransfer: Pick<DataTransfer, 'effectAllowed' | 'setData'>,
  payload: WorkspaceFileDragPayload,
): void {
  dataTransfer.effectAllowed = 'copyMove';
  dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify(payload));
  dataTransfer.setData('text/plain', payload.path);
}

export function readWorkspaceFileDrag(
  dataTransfer: Pick<DataTransfer, 'getData'> | null,
): WorkspaceFileDragPayload | null {
  if (!dataTransfer) return null;
  try {
    const value = JSON.parse(dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE)) as Partial<WorkspaceFileDragPayload>;
    if (typeof value.workspaceId !== 'string' || !value.workspaceId.trim()) return null;
    if (typeof value.path !== 'string' || !value.path.trim()) return null;
    return { workspaceId: value.workspaceId, path: value.path };
  } catch {
    return null;
  }
}

export function workspaceMoveDestination(sourcePath: string, targetFolder: string): string | null {
  const name = sourcePath.split('/').pop();
  if (!name) return null;
  const destinationPath = targetFolder ? `${targetFolder}/${name}` : name;
  return destinationPath === sourcePath ? null : destinationPath;
}
