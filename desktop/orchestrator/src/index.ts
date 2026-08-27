/**
 * verso sidecar runtime.
 *
 * Hermes-only local chat bridge for the macOS app.
 */

export { startServer } from './http/server.ts';
export { buildChatRoutes } from './chat/chat.ts';
export { ChatStore, type ChatMessageRecord, type ChatSessionRecord, type ChatSessionSummary } from './chat/chat-store.ts';
export { HermesSupervisor, getHermesGatewayConfig, type HermesRuntimeSnapshot } from './hermes/hermes-supervisor.ts';
