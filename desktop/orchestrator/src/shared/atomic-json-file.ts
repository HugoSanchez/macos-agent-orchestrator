import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Read and decode a local JSON document. Missing, corrupt, and invalid documents
 * all resolve to a fresh fallback so callers can keep their recovery policy in
 * one place without sharing mutable defaults.
 */
export function readJsonFileOr<T>(
  filePath: string,
  decode: (value: unknown) => T,
  fallback: () => T,
): T {
  try {
    return decode(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
  } catch {
    return fallback();
  }
}

/**
 * Replace a JSON document atomically. The temporary file is unique per write,
 * flushed before publication, and removed if any step fails.
 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextFileAtomic(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;

  try {
    descriptor = openSync(tempPath, 'wx');
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}
