import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserHost } from '../src/browser/browser-host.ts';

const FAKE_CHROME = fileURLToPath(new URL('./fixtures/fake-chrome.mjs', import.meta.url));

const quietLogger = { info: () => undefined, warn: () => undefined };

function makeHost(baseDir: string, overrides: Partial<{ binary: string | null }> = {}): BrowserHost {
  return new BrowserHost({
    baseDir,
    binary: 'binary' in overrides ? overrides.binary : FAKE_CHROME,
    logger: quietLogger,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condition not reached in time.');
}

describe('BrowserHost', () => {
  let baseDir: string;
  let host: BrowserHost | null = null;

  afterEach(async () => {
    if (host) await host.shutdown();
    host = null;
    rmSync(baseDir, { recursive: true, force: true });
  });

  function freshBase(): string {
    baseDir = mkdtempSync(path.join(os.tmpdir(), 'browser-host-test-'));
    return baseDir;
  }

  it('starts the browser, verifies port ownership, and exposes the CDP URL', async () => {
    host = makeHost(freshBase());
    expect(host.isEnabled()).toBe(false);
    expect(host.cdpUrl()).toBeNull();

    await host.ensureStarted();

    expect(host.isRunning()).toBe(true);
    expect(host.isEnabled()).toBe(true);
    const cdpUrl = host.cdpUrl();
    expect(cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${cdpUrl}/json/version`);
    expect(response.ok).toBe(true);
  });

  it('runs automation headlessly until the user opens the browser', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();

    const launchesPath = path.join(host.profileDir, 'fake-chrome-launches.jsonl');
    const launches = () => readFileSync(launchesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(launches()[0]).toContain('--headless=new');

    await host.open();
    await waitFor(() => launches().length >= 3);
    const managedLaunches = launches().filter((args) => args.some((arg) => arg.startsWith('--remote-debugging-port=')));
    expect(managedLaunches).toHaveLength(2);
    expect(managedLaunches[1]).not.toContain('--headless=new');
  });

  it('seeds the profile with password saving and session restore disabled', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();

    const preferences = JSON.parse(
      readFileSync(path.join(host.profileDir, 'Default', 'Preferences'), 'utf8'),
    );
    expect(preferences.credentials_enable_service).toBe(false);
    expect(preferences.profile.password_manager_enabled).toBe(false);
    expect(preferences.session.restore_on_startup).toBe(5);
    expect(preferences.profile.exit_type).toBe('Normal');
  });

  it('re-marks a crashed exit as clean on relaunch without losing other prefs', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    await host.shutdown();

    // Simulate what Chrome leaves behind after a hard quit, plus a pref the
    // user changed inside the browser that must survive our reconciliation.
    const prefsPath = path.join(host.profileDir, 'Default', 'Preferences');
    const dirty = JSON.parse(readFileSync(prefsPath, 'utf8'));
    dirty.profile.exit_type = 'Crashed';
    dirty.profile.exited_cleanly = false;
    dirty.intl = { accept_languages: 'es-ES' };
    writeFileSync(prefsPath, JSON.stringify(dirty));

    await host.ensureStarted();
    const preferences = JSON.parse(readFileSync(prefsPath, 'utf8'));
    expect(preferences.profile.exit_type).toBe('Normal');
    expect(preferences.profile.exited_cleanly).toBe(true);
    expect(preferences.session.restore_on_startup).toBe(5);
    expect(preferences.intl).toEqual({ accept_languages: 'es-ES' });
  });

  it('reset stops the browser and deletes the profile', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    const profileDir = host.profileDir;
    expect(existsSync(profileDir)).toBe(true);

    await host.reset();

    expect(host.isRunning()).toBe(false);
    expect(existsSync(profileDir)).toBe(false);
    expect(host.isEnabled()).toBe(false);
    expect(host.cdpUrl()).toBeNull();
  });

  it('does not respawn after an unexpected browser exit', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    const statePath = path.join(baseDir, 'agent-browser-host.json');
    const firstPid = JSON.parse(readFileSync(statePath, 'utf8')).pid as number;

    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => !host!.isRunning());
    expect(JSON.parse(readFileSync(statePath, 'utf8')).pid).toBeNull();
  });

  it('keeps the same port across a browser restart', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    const firstUrl = host.cdpUrl();

    await host.shutdown();
    expect(host.cdpUrl()).toBe(firstUrl);
    host = makeHost(baseDir);
    expect(host.cdpUrl()).toBe(firstUrl);
    await host.ensureStarted();

    expect(host.cdpUrl()).toBe(firstUrl);
  });

  it('reserves a CDP endpoint without starting Chrome', async () => {
    host = makeHost(freshBase());
    mkdirSync(host.profileDir, { recursive: true });

    await host.prepareCdpEndpoint();
    const cdpUrl = host.cdpUrl();

    expect(cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(host.isRunning()).toBe(false);
    expect(JSON.parse(readFileSync(path.join(baseDir, 'agent-browser-host.json'), 'utf8')).port).not.toBeNull();
  });

  it('sweeps a stale process only when its identity matches', async () => {
    host = makeHost(freshBase());
    const statePath = path.join(baseDir, 'agent-browser-host.json');

    // A live process whose command line does NOT reference our binary+profile
    // must survive the sweep even when the pidfile points at it.
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeFileSync(statePath, JSON.stringify({
      pid: bystander.pid,
      binary: FAKE_CHROME,
      port: null,
    }));
    await host.sweepStaleProcess();
    expect(bystander.exitCode).toBeNull();
    bystander.kill('SIGKILL');

    // A process that matches the recorded binary and profile dir is ours from
    // a previous run and must be killed.
    const stale = spawn(FAKE_CHROME, [
      `--user-data-dir=${host.profileDir}`,
      '--remote-debugging-port=0',
    ], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      stale.once('spawn', resolve);
      stale.once('error', reject);
    });
    writeFileSync(statePath, JSON.stringify({
      pid: stale.pid,
      binary: FAKE_CHROME,
      port: null,
    }));
    await host.sweepStaleProcess();
    await waitFor(() => stale.exitCode !== null || stale.signalCode !== null, 5_000);
  }, 15_000);

  it('reports unsupported when no browser binary exists', async () => {
    host = makeHost(freshBase(), { binary: null });
    expect(host.status().supported).toBe(false);
    await expect(host.ensureStarted()).rejects.toThrow(/No Chromium-family browser/);
  });
});
