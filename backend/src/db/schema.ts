import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  workosUserId: text('workos_user_id').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  deviceLabel: text('device_label').notNull(),
  platform: text('platform').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const entitlements = pgTable('entitlements', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  mode: text('mode').notNull(),
  status: text('status').notNull(),
  monthlyUsdLimit: text('monthly_usd_limit'),
  dailyUsdLimit: text('daily_usd_limit'),
  allowedModels: jsonb('allowed_models').$type<string[] | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const analyticsEvents = pgTable('analytics_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  deviceId: text('device_id'),
  eventType: text('event_type').notNull(),
  sessionId: text('session_id'),
  toolCallCount: integer('tool_call_count'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

// Legacy table retained for production data retention. No runtime code writes
// managed inference requests after the desktop LLM proxy removal.
export const inferenceRequests = pgTable('inference_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  deviceId: text('device_id').notNull(),
  localSessionId: text('local_session_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  requestStartedAt: timestamp('request_started_at', { withTimezone: true }).notNull(),
  requestCompletedAt: timestamp('request_completed_at', { withTimezone: true }),
  status: text('status').notNull(),
  inputTokens: text('input_tokens'),
  outputTokens: text('output_tokens'),
  cachedTokens: text('cached_tokens'),
  reasoningTokens: text('reasoning_tokens'),
  estimatedCostUsd: text('estimated_cost_usd'),
  providerRequestId: text('provider_request_id'),
  errorCode: text('error_code'),
});
