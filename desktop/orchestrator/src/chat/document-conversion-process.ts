import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024;
const WORKER_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);
const TSX_PATH = require.resolve('tsx/cli');
const WORKER_PATH = fileURLToPath(new URL('./document-conversion-worker.ts', import.meta.url));

/**
 * Run document WASM outside the long-lived sidecar. Some valid, complex PDFs
 * trigger a fatal V8 optimizer abort after conversion has completed; keeping
 * that runtime in a worker prevents one document from disconnecting the app.
 */
export function convertDocumentFileToMarkdown(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [TSX_PATH, WORKER_PATH, filePath],
      { encoding: 'utf8', maxBuffer: MAX_WORKER_OUTPUT_BYTES, timeout: WORKER_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const result = parseDocumentWorkerOutput(stdout);
        if (result.ok) {
          // A native WASM optimizer abort can race after the worker has written
          // a complete result. The framed output is authoritative in that case.
          resolve(result.markdown);
          return;
        }

        const detail = result.message
          || firstUsefulLine(stderr)
          || (error instanceof Error ? error.message : 'Document conversion failed.');
        reject(new Error(detail));
      },
    );
  });
}

export type DocumentWorkerOutput =
  | { ok: true; markdown: string }
  | { ok: false; message: string | null };

export function parseDocumentWorkerOutput(stdout: string): DocumentWorkerOutput {
  if (stdout.startsWith('ok\n')) return { ok: true, markdown: stdout.slice(3) };
  if (stdout.startsWith('error\n')) {
    return { ok: false, message: stdout.slice(6).trim() || null };
  }
  return { ok: false, message: null };
}

function firstUsefulLine(stderr: string): string | null {
  return stderr.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}
