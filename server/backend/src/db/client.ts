import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema.ts';

let cachedDb: NeonHttpDatabase<typeof schema> | null = null;
let cachedUrl: string | null = null;

export function getDb(databaseUrl: string): NeonHttpDatabase<typeof schema> {
  if (cachedDb && cachedUrl === databaseUrl) {
    return cachedDb;
  }

  const client = neon(databaseUrl);
  cachedDb = drizzle({ client, schema });
  cachedUrl = databaseUrl;
  return cachedDb;
}
