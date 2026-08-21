export type RuntimeMode = 'managed' | 'byo' | 'local';

const VALID_MODES: RuntimeMode[] = ['managed', 'byo', 'local'];

/**
 * The orchestrator exposes the runtime mode so the macOS app can render account
 * state and future BYO/local paths can branch cleanly. Model inference is owned
 * by Hermes' configured provider, not by the managed backend.
 */
export function readRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const raw = env.VERSO_RUNTIME_MODE?.trim().toLowerCase() ?? '';
  if (raw && (VALID_MODES as string[]).includes(raw)) {
    return raw as RuntimeMode;
  }
  return 'local';
}
