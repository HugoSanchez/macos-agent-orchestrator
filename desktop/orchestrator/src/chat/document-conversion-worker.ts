import { readFileSync, writeFileSync } from 'node:fs';
import { convertDocumentBytesToMarkdown } from './document-conversion.ts';

const filePath = process.argv[2];

void (async () => {
  if (!filePath) throw new Error('Document path is required.');
  const markdown = await convertDocumentBytesToMarkdown(readFileSync(filePath));
  // Write synchronously so the parent can retain a completed conversion even
  // if V8 aborts while optimizing the converter's WASM in the background.
  writeFileSync(process.stdout.fd, `ok\n${markdown}`);
})().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(process.stdout.fd, `error\n${message}`);
  process.exitCode = 1;
});
