/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposioSettings } from './ComposioSettings';

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn() }));
vi.mock('./chat', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chat')>(), requestJson,
  getConnections: vi.fn(async () => ({ available: true, configured: true, connections: [] })),
}));

let root: Root;
let container: HTMLDivElement;
const emptyProject = { provider: 'user', editable: true, saved: false, active: false, restartRequired: false, userId: null };

beforeEach(() => {
  requestJson.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Connected-app settings', () => {
  it('submits the key only on save, clears it, and explains the required restart', async () => {
    requestJson.mockResolvedValueOnce(emptyProject).mockResolvedValueOnce({ ...emptyProject, saved: true, restartRequired: true });
    await act(async () => root.render(<ComposioSettings />));
    const input = container.querySelector('input')!;
    expect(input.type).toBe('password');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-project-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const init = requestJson.mock.calls[1][2] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'test-project-key' });
    expect(input.value).toBe('');
    expect(container.textContent).toContain('Quit and reopen Verso');
    expect(container.textContent).not.toContain('test-project-key');
  });

  it('keeps the active status and displays the error if removal fails', async () => {
    requestJson.mockResolvedValueOnce({ ...emptyProject, saved: true, active: true }).mockRejectedValueOnce(new Error('Could not update Composio settings.'));
    await act(async () => root.render(<ComposioSettings />));
    const remove = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Remove key')!;
    await act(async () => remove.click());
    expect(requestJson.mock.calls[1][2]).toEqual({ method: 'DELETE' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not update');
    expect(container.querySelector<HTMLButtonElement>('button[type="button"]')?.disabled).toBe(false);
  });

  it('explains the managed service without offering a project-key editor', async () => {
    requestJson.mockResolvedValueOnce({ ...emptyProject, provider: 'managed', editable: false });
    await act(async () => root.render(<ComposioSettings />));
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('managed service');
  });
});
