import { spawn } from 'node:child_process';

const command = process.env.VERSO_HERMES_CHILD_COMMAND || '';
const cwd = process.env.VERSO_HERMES_CHILD_CWD || process.cwd();
const args = parseArgs(process.env.VERSO_HERMES_CHILD_ARGS);

if (!command) {
  console.error('[hermes runner] missing child command');
  process.exit(1);
}

const child = spawn(command, args, {
  cwd,
  env: process.env,
  stdio: 'inherit',
});

let shuttingDown = false;

const shutdown = (signal = 'SIGTERM') => {
  if (child.exitCode !== null || child.signalCode !== null) {
    process.exit(0);
    return;
  }
  if (shuttingDown) return;
  shuttingDown = true;

  child.kill(signal);
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 2_000).unref();
};

// Parent-orphaning detection. The supervisor spawns us with an IPC stdio
// slot — when the parent dies, the IPC channel closes and `disconnect`
// fires. This replaces a previous setInterval(1s) that polled `process.ppid`
// just to detect orphaning; the timer was waking the CPU once per second
// even when the laptop was lid-closed and trying to sleep.
process.on('disconnect', () => shutdown('SIGTERM'));

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => shutdown('SIGTERM'));

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function parseArgs(raw) {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through.
  }
  return raw.trim().split(/\s+/).filter(Boolean);
}
