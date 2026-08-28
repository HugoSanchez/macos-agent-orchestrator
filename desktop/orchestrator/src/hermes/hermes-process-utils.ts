import type { ChildProcess } from 'node:child_process';
import net from 'node:net';

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function terminateChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  const exited = childExitPromise(child);
  child.kill('SIGTERM');
  let didExit = await waitForExit(exited, 2_000);
  if (!didExit && !hasExited(child)) {
    child.kill('SIGKILL');
    didExit = await waitForExit(exited, 1_000);
  }
  if (!didExit && !hasExited(child)) {
    throw new Error(`Hermes gateway process ${child.pid ?? 'unknown'} did not exit after SIGKILL.`);
  }
}

export async function allocatePort(host: string): Promise<number> {
  const server = net.createServer();
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate Hermes port.')));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function canBind(host: string, port: number): Promise<boolean> {
  const server = net.createServer();
  server.unref();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close((error) => resolve(!error));
    });
  });
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function childExitPromise(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    if (hasExited(child)) {
      child.off('exit', onExit);
      resolve();
    }
  });
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}
