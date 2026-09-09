import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not configured.');
    process.exit(1);
  }

  const client = neon(databaseUrl);
  const db = drizzle({ client });

  console.log('[db] applying migrations from ./migrations…');
  await migrate(db, { migrationsFolder: './migrations' });
  console.log('[db] migrations applied.');
}

main().catch((error: unknown) => {
  console.error('[db] migration failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
