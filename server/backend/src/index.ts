import { buildServer } from './server.ts';
import { getConfig } from './config.ts';

async function main(): Promise<void> {
  const config = getConfig();
  const app = await buildServer({ config });

  try {
    await app.listen({
      host: config.HOST,
      port: config.PORT,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/index.ts') ||
  process.argv[1].endsWith('/index.js')
);

if (isMain) {
  void main();
}
