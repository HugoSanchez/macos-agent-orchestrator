/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogOverlay } from './CatalogOverlay';

const { addCustomConnector, getCustomConnectorOAuthSettings, openCustomConnectorAuth } = vi.hoisted(() => ({
  addCustomConnector: vi.fn(), getCustomConnectorOAuthSettings: vi.fn(), openCustomConnectorAuth: vi.fn(),
}));
vi.mock('./chat', () => ({
  addCustomConnector, getCustomConnectorOAuthSettings, openCustomConnectorAuth,
  getToolkits: vi.fn(async () => ({ toolkits: [], nextCursor: null })),
  resolveSidecarUrl: (url: string) => url,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  getCustomConnectorOAuthSettings.mockResolvedValue({ redirectUri: 'http://localhost:43821/oauth/callback' });
  addCustomConnector.mockResolvedValue({ id: 'hubspot', status: { state: 'pending_auth' } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
  await act(async () => button.click());
}

async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openForm() {
  await act(async () => root.render(<CatalogOverlay isOpen refreshToken={0} connectingToolkitSlugs={new Set()}
    onClose={() => {}} onConnect={() => {}} />));
  await click('Add a custom connector');
  await fill('input[placeholder="Name"]', 'HubSpot');
  await fill('input[placeholder="https://example.com/mcp"]', 'https://mcp.hubspot.com');
}

it('shows the callback before connection, submits manual credentials, and opens browser sign-in', async () => {
  await openForm();
  await click('OAuth settings (optional)');
  const redirect = container.querySelector<HTMLInputElement>('#custom-oauth-redirect')!;
  expect(redirect.readOnly).toBe(true);
  expect(redirect.value).toBe('http://localhost:43821/oauth/callback');
  expect(addCustomConnector).not.toHaveBeenCalled();
  const connect = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Connect')!;
  expect(connect.disabled).toBe(true);
  await fill('#custom-oauth-client-id', 'hubspot-client');
  await fill('#custom-oauth-client-secret', 'private-secret');
  expect(container.querySelector<HTMLInputElement>('#custom-oauth-client-secret')!.type).toBe('password');
  await click('Connect');
  expect(addCustomConnector).toHaveBeenCalledWith({
    name: 'HubSpot', url: 'https://mcp.hubspot.com', oauth: { clientId: 'hubspot-client', clientSecret: 'private-secret' },
  });
  expect(openCustomConnectorAuth).toHaveBeenCalledWith('hubspot');
  await click('Add a custom connector');
  await click('OAuth settings (optional)');
  expect(container.querySelector<HTMLInputElement>('#custom-oauth-client-secret')!.value).toBe('');
});

it('keeps automatic OAuth unchanged when manual settings are unused', async () => {
  await openForm();
  await click('Connect');
  expect(addCustomConnector).toHaveBeenCalledWith({ name: 'HubSpot', url: 'https://mcp.hubspot.com' });
  expect(getCustomConnectorOAuthSettings).not.toHaveBeenCalled();
  expect(openCustomConnectorAuth).toHaveBeenCalledWith('hubspot');
});
