export function installParentDeathWatcher(onParentGone: () => void): void {
  const raw = process.env.VERSO_PARENT_PID;
  const parentPid = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parentPid) || parentPid <= 1) {
    console.error('[sidecar] VERSO_PARENT_PID not set; parent-death detection disabled');
    return;
  }

  console.error(`[sidecar] watching parent pid=${parentPid}`);
  const interval = setInterval(() => {
    try {
      // Signal 0 only probes whether the process still exists.
      process.kill(parentPid, 0);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        clearInterval(interval);
        console.error(`[sidecar] parent pid=${parentPid} no longer exists, exiting`);
        onParentGone();
      }
    }
  }, 2_000);
  interval.unref();
}

export function installDiagnosticHandlers(): void {
  // The native parent owns these pipes. Swallow EPIPE while the parent watcher
  // notices a force-quit so an orphaned sidecar cannot spin on failed writes.
  process.stdout.on('error', () => { /* swallow EPIPE */ });
  process.stderr.on('error', () => { /* swallow EPIPE */ });

  process.on('unhandledRejection', (reason, promise) => {
    const message = reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
    console.error(`[sidecar] unhandledRejection ${new Date().toISOString()}\n${message}`);
    try {
      console.error(`[sidecar] unhandledRejection promise: ${String(promise)}`);
    } catch { /* ignore */ }
  });

  process.on('uncaughtException', (error, origin) => {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
    console.error(`[sidecar] uncaughtException origin=${origin} ${new Date().toISOString()}\n${message}`);
  });

  setInterval(() => {
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / 1024 / 1024);
    const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
    console.error(`[sidecar] heartbeat ${new Date().toISOString()} pid=${process.pid} rss=${rssMb}MB heap=${heapMb}MB`);
  }, 60_000).unref();
}

export function classifyStartupError(error: unknown): {
  status: 'error';
  code: 'startup_failed' | 'unknown';
  message: string;
  recoverable: boolean;
  details?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('eaddrinuse') || normalized.includes('address already in use')) {
    return {
      status: 'error',
      code: 'startup_failed',
      message: 'Sidecar port is already in use.',
      recoverable: false,
      details: message,
    };
  }

  return {
    status: 'error',
    code: 'unknown',
    message: 'Sidecar failed to start.',
    recoverable: false,
    details: message,
  };
}
