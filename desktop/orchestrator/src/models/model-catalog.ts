// Single source of truth for the chat models Verso exposes, keyed by the
// provider that serves them. Consumed by:
//   - chat/chat.ts        — per-request model allowlist
//   - hermes-supervisor   — api_server model_routes (cross-provider routing)
//   - model-auth.ts       — default model written on Anthropic connect
// The chat-ui mirror lives in desktop/chat-ui/src/types.ts (CHAT_MODELS).

export const CODEX_CHAT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;

// First entry doubles as the model.default written on Anthropic connect.
export const ANTHROPIC_CHAT_MODELS = ['claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

export const VALID_CHAT_MODELS = [...CODEX_CHAT_MODELS, ...ANTHROPIC_CHAT_MODELS] as const;

export type ChatModel = (typeof VALID_CHAT_MODELS)[number];
