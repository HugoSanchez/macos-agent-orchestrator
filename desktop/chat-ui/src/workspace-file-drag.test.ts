import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_FILE_DRAG_TYPE,
  isWorkspaceFileDrag,
  readWorkspaceFileDrag,
  workspaceMoveDestination,
  writeWorkspaceFileDrag,
} from './workspace-file-drag';

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      values.set(type, value);
      transfer.types = [...values.keys()];
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
  return transfer as unknown as DataTransfer;
}

describe('workspace file drag payloads', () => {
  it('serializes a workspace file for an internal drag', () => {
    const transfer = dataTransfer();
    writeWorkspaceFileDrag(transfer, { workspaceId: 'workspace-1', path: 'Sources/report.pdf' });

    expect(transfer.effectAllowed).toBe('copyMove');
    expect(isWorkspaceFileDrag(transfer)).toBe(true);
    expect(readWorkspaceFileDrag(transfer)).toEqual({ workspaceId: 'workspace-1', path: 'Sources/report.pdf' });
    expect(transfer.getData('text/plain')).toBe('Sources/report.pdf');
  });

  it('rejects malformed payloads', () => {
    const transfer = dataTransfer();
    transfer.setData(WORKSPACE_FILE_DRAG_TYPE, '{bad json');
    expect(readWorkspaceFileDrag(transfer)).toBeNull();
  });

  it('builds move destinations for folders and the workspace root', () => {
    expect(workspaceMoveDestination('Sources/report.pdf', 'Archive')).toBe('Archive/report.pdf');
    expect(workspaceMoveDestination('Sources/report.pdf', '')).toBe('report.pdf');
    expect(workspaceMoveDestination('Sources/report.pdf', 'Sources')).toBeNull();
  });
});
