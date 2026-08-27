import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { readJsonFileOr, writeJsonFileAtomic } from '../src/shared/atomic-json-file.ts';

describe('atomic JSON files', () => {
  it('returns a fresh fallback for missing, corrupt, and rejected documents', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-atomic-json-'));
    const filePath = path.join(tempDir, 'state.json');
    let fallbackCalls = 0;
    const read = () => readJsonFileOr(
      filePath,
      (value) => {
        if (!value || typeof value !== 'object' || !('version' in value)) {
          throw new Error('invalid document');
        }
        return value as { version: number };
      },
      () => ({ version: --fallbackCalls }),
    );

    expect(read()).toEqual({ version: -1 });
    writeFileSync(filePath, '{not-json', 'utf8');
    expect(read()).toEqual({ version: -2 });
    writeFileSync(filePath, '[]\n', 'utf8');
    expect(read()).toEqual({ version: -3 });
  });

  it('serializes deterministically and publishes without a leftover temp file', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-atomic-json-'));
    const filePath = path.join(tempDir, 'nested', 'state.json');

    writeJsonFileAtomic(filePath, { version: 1, items: ['a', 'b'] });

    expect(readFileSync(filePath, 'utf8')).toBe([
      '{',
      '  "version": 1,',
      '  "items": [',
      '    "a",',
      '    "b"',
      '  ]',
      '}',
      '',
    ].join('\n'));
    expect(readdirSync(path.dirname(filePath))).toEqual(['state.json']);
  });

  it('removes its temp file when the atomic replacement fails', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-atomic-json-'));
    const directoryAtTarget = path.join(tempDir, 'state.json');
    mkdirSync(directoryAtTarget);

    expect(() => writeJsonFileAtomic(directoryAtTarget, { version: 1 })).toThrow();

    expect(readdirSync(tempDir)).toEqual(['state.json']);
    expect(existsSync(directoryAtTarget)).toBe(true);
  });

  it('keeps the published document valid across concurrent writers', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-atomic-json-'));
    const filePath = path.join(tempDir, 'state.json');
    const workerPath = path.join(tempDir, 'writer.mjs');
    const moduleUrl = new URL('../src/shared/atomic-json-file.ts', import.meta.url).href;
    writeFileSync(workerPath, [
      "import { workerData } from 'node:worker_threads';",
      'const { writeJsonFileAtomic } = await import(workerData.moduleUrl);',
      'for (let sequence = 0; sequence < 10; sequence += 1) {',
      '  writeJsonFileAtomic(workerData.filePath, { writer: workerData.writer, sequence });',
      '}',
    ].join('\n'), 'utf8');

    await Promise.all(Array.from({ length: 4 }, (_, writer) => new Promise<void>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { filePath, moduleUrl, writer },
        execArgv: ['--import', 'tsx'],
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writer ${writer} exited with code ${code}`));
      });
    })));

    const published = JSON.parse(readFileSync(filePath, 'utf8')) as { writer: number; sequence: number };
    expect(published.writer).toBeGreaterThanOrEqual(0);
    expect(published.writer).toBeLessThan(4);
    expect(published.sequence).toBe(9);
    expect(readdirSync(tempDir).sort()).toEqual(['state.json', 'writer.mjs']);
  });
});
