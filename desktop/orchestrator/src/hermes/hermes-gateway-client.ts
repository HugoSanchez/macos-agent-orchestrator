import type { HermesGatewayConfig } from './hermes-runtime-config.ts';

export function hermesGatewayAuthHeaders(config: Pick<HermesGatewayConfig, 'apiKey'>): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

// One-shot, non-streaming /v1/responses completion (session titles, cron
// descriptions). Returns the assistant text, '' when the gateway answers
// without one; network/timeout errors propagate for the caller to handle.
export async function hermesOneShotText(
  config: Pick<HermesGatewayConfig, 'baseUrl' | 'apiKey'>,
  input: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...hermesGatewayAuthHeaders(config) },
    body: JSON.stringify({ input, truncation: 'auto', stream: false, store: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return '';
  const data = await res.json() as Record<string, unknown>;
  return extractAssistantText(data);
}

// Walks an OpenAI-shaped response object for the latest assistant message's
// output_text. Shared by the one-shot helper above and chat.ts streaming.
export function extractAssistantText(response: Record<string, unknown> | null | undefined): string {
  const output = Array.isArray(response?.output) ? response.output : [];
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'message' || record.role !== 'assistant') continue;
    const content = Array.isArray(record.content) ? record.content : [];
    return content
      .map((block) => {
        const blk = block && typeof block === 'object' ? block as Record<string, unknown> : null;
        return blk?.type === 'output_text' && typeof blk.text === 'string' ? blk.text : '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

export async function fetchRegisteredToolNames(config: Pick<HermesGatewayConfig, 'baseUrl' | 'apiKey'>): Promise<string[] | null> {
  // /api/mcp/tools comes from the verso-gateway-mcp-oauth runtime patch and
  // reports the gateway's actual MCP tool registry per server. The previous
  // source, /v1/toolsets, lists only built-in toolsets — MCP servers (verso,
  // composio, custom_*) never appear there, so registration checks against it
  // always came back empty and connector status could never reach "connected".
  try {
    const res = await fetch(`${config.baseUrl}/api/mcp/tools`, {
      method: 'GET',
      headers: hermesGatewayAuthHeaders(config),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { servers?: Record<string, string[]> };
    if (!body?.servers || typeof body.servers !== 'object') return null;
    return Object.values(body.servers).flatMap((tools) => (Array.isArray(tools) ? tools : []));
  } catch {
    return null;
  }
}

export function countCustomConnectorTools(registered: readonly string[], slug: string): number {
  const doublePrefix = `mcp__custom_${slug}__`;
  const singlePrefix = `mcp_custom_${slug}_`;
  return registered.filter((name) => name.startsWith(doublePrefix) || name.startsWith(singlePrefix)).length;
}
