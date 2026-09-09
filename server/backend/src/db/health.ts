import { sql } from 'drizzle-orm';
import { getDb } from './client.ts';

export interface DatabaseHealth {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

export async function checkDatabaseHealth(databaseUrl: string | undefined): Promise<DatabaseHealth> {
  if (!databaseUrl) {
    return {
      configured: false,
      reachable: false,
      latencyMs: null,
      error: 'DATABASE_URL is not configured.',
    };
  }

  const startedAt = Date.now();

  try {
    const db = getDb(databaseUrl);
    await db.execute(sql`select 1`);
    return {
      configured: true,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error: unknown) {
    return {
      configured: true,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
