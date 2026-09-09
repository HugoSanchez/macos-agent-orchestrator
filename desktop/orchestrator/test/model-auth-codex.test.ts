import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAstraAvailableForCodexUser } from '../src/models/model-auth.ts';

describe('Codex Astra availability', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function codexHome(): string {
    const home = mkdtempSync(path.join(os.tmpdir(), 'verso-codex-models-'));
    tempDirs.push(home);
    return home;
  }

  it('only surfaces Astra when the user-scoped Codex cache lists it as visible', () => {
    const home = codexHome();
    writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol' },
        { slug: 'gpt-6-astra', visibility: 'visible' },
      ],
    }));
    expect(isAstraAvailableForCodexUser(home)).toBe(true);
  });

  it('does not infer access from the static catalog or hidden cache entries', () => {
    const home = codexHome();
    writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-6-astra', visibility: 'hidden' }],
    }));
    expect(isAstraAvailableForCodexUser(home)).toBe(false);
    expect(isAstraAvailableForCodexUser(path.join(home, 'missing'))).toBe(false);
  });
});
