import 'dotenv/config';
import http from 'node:http';
import { createSidecarRuntime } from '../app/create-runtime.ts';
import {
  classifyStartupError,
  installDiagnosticHandlers,
  installParentDeathWatcher,
} from '../app/process-lifecycle.ts';
import { dispatch } from './router.ts';

export interface StartServerOptions {
  port?: number;
  authSecret?: string | null;
  allowUnauthenticated?: boolean;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

/** Bind the HTTP transport around a fully constructed sidecar runtime. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const runtime = await createSidecarRuntime();
  const authSecret = opts.authSecret ?? process.env.VERSO_SIDECAR_AUTH_SECRET ?? null;
  const nativeLaunch = Boolean(process.env.VERSO_PARENT_PID);
  const allowUnauthenticated = !nativeLaunch && (
    opts.allowUnauthenticated === true
    || process.env.VERSO_ALLOW_UNAUTHENTICATED_SIDECAR === '1'
  );
  if (!authSecret && !allowUnauthenticated) {
    throw new Error(
      'VERSO_SIDECAR_AUTH_SECRET is required. For local development only, set VERSO_ALLOW_UNAUTHENTICATED_SIDECAR=1.',
    );
  }

  const server = http.createServer((req, res) => {
    dispatch(runtime.routes, req, res, { authSecret, allowUnauthenticated });
  });
  server.on('close', () => {
    runtime.chatRequests.cancelAll();
    void runtime.stop();
  });

  const port = opts.port ?? parseInt(process.env.PORT || '0', 10);
  const close = async () => {
    runtime.chatRequests.cancelAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await runtime.stop();
  };

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', async () => {
      const addr = server.address() as { port: number };
      runtime.setOrchestratorBaseUrl(`http://127.0.0.1:${addr.port}`);
      await runtime.startBackgroundServices();
      resolve({ server, port: addr.port, close });
    });
  });
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/server.ts')
  || process.argv[1].endsWith('/server.js')
);

if (isMain) {
  installDiagnosticHandlers();

  startServer().then(({ close, port }) => {
    console.log(JSON.stringify({ port, status: 'ready', pid: process.pid }));

    const shutdown = (reason: string) => {
      console.error(`[sidecar] ${reason}, shutting down`);
      void close().finally(() => process.exit(0));
    };

    process.on('SIGTERM', () => shutdown('received SIGTERM'));
    process.on('SIGINT', () => shutdown('received SIGINT'));
    process.on('SIGHUP', () => shutdown('received SIGHUP'));
    process.on('beforeExit', (code) => {
      console.error(`[sidecar] beforeExit code=${code} — event loop drained`);
    });
    process.on('exit', (code) => {
      console.error(`[sidecar] exit code=${code}`);
    });

    installParentDeathWatcher(() => shutdown('parent process gone'));
  }).catch((error: unknown) => {
    console.error(JSON.stringify(classifyStartupError(error)));
    process.exit(1);
  });
}
