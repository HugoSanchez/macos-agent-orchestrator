import 'dotenv/config';
import { z } from 'zod';

const optionalString = () => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: optionalString(),
  WORKOS_API_KEY: optionalString(),
  WORKOS_CLIENT_ID: optionalString(),
  WORKOS_ISSUER_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  WORKOS_JWKS_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  WEB_BASE_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
});

export type BackendConfig = z.infer<typeof envSchema> & {
  databaseConfigured: boolean;
  workosConfigured: boolean;
  workosIssuer: string;
  workosJwksUrl: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse(env);
  const workosConfigured = Boolean(parsed.WORKOS_API_KEY && parsed.WORKOS_CLIENT_ID);

  return {
    ...parsed,
    databaseConfigured: Boolean(parsed.DATABASE_URL),
    workosConfigured,
    workosIssuer: parsed.WORKOS_ISSUER_URL
      ?? `https://api.workos.com/user_management/${encodeURIComponent(parsed.WORKOS_CLIENT_ID ?? '')}`,
    workosJwksUrl: parsed.WORKOS_JWKS_URL
      ?? `https://api.workos.com/sso/jwks/${encodeURIComponent(parsed.WORKOS_CLIENT_ID ?? '')}`,
  };
}
