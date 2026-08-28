import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ComposioManifestCoordinator } from '../src/connections/composio-manifest.ts';

describe('ComposioManifestCoordinator', () => {
  let tempRoot = '';

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  function setup(initialToolkits: string[] = []) {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-composio-coordinator-'));
    const manifestPath = path.join(tempRoot, 'verso-composio-tools.json');
    const activeToolkits: string[] = [...initialToolkits];
    const refreshNativeToolManifest = vi.fn(async () => {});
    const writeFallbackManifest = vi.fn((filePath: string, toolkits: string[]) => {
      writeManifest(filePath, toolkits);
    });
    const restartHermes = vi.fn(async () => {});
    const logger = { warn: vi.fn(), error: vi.fn() };
    const coordinator = new ComposioManifestCoordinator({
      manifestPath,
      getActiveToolkitSlugs: () => [...activeToolkits],
      refreshNativeToolManifest,
      writeFallbackManifest,
      restartHermes,
      logger,
    });
    return {
      manifestPath,
      activeToolkits,
      refreshNativeToolManifest,
      writeFallbackManifest,
      restartHermes,
      logger,
      coordinator,
    };
  }

  test('only gates Hermes startup when active apps have no usable manifest', () => {
    const fixture = setup(['gmail']);
    expect(fixture.coordinator.needsManifestBeforeHermesStart()).toBe(true);

    writeManifest(fixture.manifestPath, ['verso']);
    expect(fixture.coordinator.needsManifestBeforeHermesStart()).toBe(true);

    writeManifest(fixture.manifestPath, ['gmail']);
    expect(fixture.coordinator.needsManifestBeforeHermesStart()).toBe(false);

    fixture.activeToolkits.length = 0;
    rmSync(fixture.manifestPath);
    expect(fixture.coordinator.needsManifestBeforeHermesStart()).toBe(false);
  });

  test('schedules one restart for identical toolkit changes while restart is pending', async () => {
    const fixture = setup(['gmail']);
    writeManifest(fixture.manifestPath, ['gmail']);
    fixture.coordinator.captureRegisteredManifest();

    let finishRestart!: () => void;
    fixture.restartHermes.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRestart = resolve;
    }));
    fixture.activeToolkits.push('slack');
    fixture.refreshNativeToolManifest.mockImplementation(async () => {
      writeManifest(fixture.manifestPath, ['gmail', 'slack']);
    });

    await Promise.all([fixture.coordinator.refresh(), fixture.coordinator.refresh()]);
    await vi.waitFor(() => expect(fixture.restartHermes).toHaveBeenCalledTimes(1));
    finishRestart();
    await fixture.coordinator.waitForPendingRestarts();

    expect(fixture.logger.warn).toHaveBeenCalledTimes(1);
  });

  test('does not restart for initial refreshes before Hermes captures the manifest', async () => {
    const fixture = setup(['gmail']);
    fixture.refreshNativeToolManifest.mockImplementation(async () => {
      writeManifest(fixture.manifestPath, ['gmail']);
    });

    await fixture.coordinator.refresh();
    await fixture.coordinator.waitForPendingRestarts();

    expect(fixture.restartHermes).not.toHaveBeenCalled();
  });

  test('keeps a usable manifest when refresh fails and otherwise writes the learned-tools fallback', async () => {
    const fixture = setup(['gmail']);
    fixture.refreshNativeToolManifest.mockRejectedValue(new Error('backend offline'));
    writeManifest(fixture.manifestPath, ['gmail']);

    await fixture.coordinator.refresh();
    expect(fixture.writeFallbackManifest).not.toHaveBeenCalled();

    rmSync(fixture.manifestPath);
    await fixture.coordinator.refresh();
    expect(fixture.writeFallbackManifest).toHaveBeenCalledWith(fixture.manifestPath, ['gmail']);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('backend offline'),
    );
  });

  test('rolls back optimistic toolkit registration when restart fails so refresh can retry', async () => {
    const fixture = setup(['gmail']);
    writeManifest(fixture.manifestPath, ['gmail']);
    fixture.coordinator.captureRegisteredManifest();
    fixture.activeToolkits.push('slack');
    fixture.refreshNativeToolManifest.mockImplementation(async () => {
      writeManifest(fixture.manifestPath, ['gmail', 'slack']);
    });
    fixture.restartHermes
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined);

    await fixture.coordinator.refresh();
    await fixture.coordinator.waitForPendingRestarts();
    expect(fixture.restartHermes).toHaveBeenCalledTimes(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(expect.stringContaining('restart failed'));

    await fixture.coordinator.refresh();
    await fixture.coordinator.waitForPendingRestarts();
    expect(fixture.restartHermes).toHaveBeenCalledTimes(2);
  });
});

function writeManifest(filePath: string, toolkitSlugs: string[]): void {
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    tools: toolkitSlugs.map((toolkitSlug) => ({
      toolkitSlug,
      toolSlug: `${toolkitSlug.toUpperCase()}_TEST_TOOL`,
    })),
  }), 'utf8');
}
