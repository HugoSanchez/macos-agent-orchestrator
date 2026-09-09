// Local document → Markdown conversion for chat attachments.
//
// Documents (PDF, Word, PowerPoint) can't ride the Hermes chat wire the way
// images do — Hermes' /v1/responses rejects file/input_file parts. So we do
// the extraction ourselves, fully in-process and offline, and inject the
// resulting Markdown into the prompt text. No network, no Firecrawl API key.
//
// We use `@firecrawl/anydoc-wasm` (not the native `@firecrawl/anydoc`)
// deliberately: the WASM build is a single platform-agnostic `.wasm` data file
// with no per-arch native `.node` binaries, so it needs no code-signing entry
// in the notarization matrix and no platform install fan-out inside the
// packaged app. `--target web` means we can't call the default `init()` (it
// wants `fetch`); instead we read the module bytes off disk and `initSync`.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { AttachmentValidationError } from './attachments.ts';

// Per-document cap on injected Markdown. Long enough to carry a substantial
// report, short enough that a handful of documents can't blow the context
// window on their own. On overflow we keep the head and add a visible note.
export const MAX_DOCUMENT_MARKDOWN_CHARS = 150_000;

// Bump whenever a dependency or post-processing change can alter the Markdown.
// Workspace indexing includes this in its persistent cache key.
export const DOCUMENT_MARKDOWN_CACHE_VERSION = '@firecrawl/anydoc-wasm@0.1.6:markdown-v1';

// Below this many non-whitespace characters we treat the extraction as empty
// (a scanned / image-only document) rather than a real text document.
const NEAR_EMPTY_NON_WHITESPACE_CHARS = 20;

interface AnydocModule {
  initSync(module: { module: BufferSource } | BufferSource): unknown;
  toMarkdownBytes(bytes: Uint8Array, format?: string | null): string;
}

let anydocReady: Promise<AnydocModule> | null = null;

async function loadAnydoc(): Promise<AnydocModule> {
  if (!anydocReady) {
    anydocReady = (async () => {
      const mod = (await import('@firecrawl/anydoc-wasm')) as unknown as AnydocModule;
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm');
      mod.initSync({ module: readFileSync(wasmPath) });
      return mod;
    })().catch((error) => {
      // Let a later attempt retry instead of caching a poisoned init.
      anydocReady = null;
      throw error;
    });
  }
  return anydocReady;
}

// User-facing copy for each failure mode. Kept terse and blame-free to match
// the app's tone. Encrypted is the one case worth naming precisely so the user
// knows the fix (remove the password); everything else stays generic.
const PASSWORD_MESSAGE =
  "This document is password-protected, which isn't supported yet. Remove the password and try again.";
const SCANNED_MESSAGE =
  "This document looks scanned or image-only, so there's no readable text yet.";
const GENERIC_MESSAGE =
  "Couldn't read this document. It may be corrupted or in an unsupported format.";

// anydoc throws an Error carrying a `ConvertErrorCode` on `.code`. Map that
// taxonomy onto our user-facing messages. `unsupported` covers both unknown
// formats and image-only PDFs (whose message mentions OCR), so we sniff the
// message to route the scanned case to the friendlier copy.
export function describeConversionError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === 'encrypted') return PASSWORD_MESSAGE;
  if (code === 'unsupported' && /ocr|scan|image[- ]only|no extractable text/i.test(message)) {
    return SCANNED_MESSAGE;
  }
  return GENERIC_MESSAGE;
}

// Trim over-long Markdown to the head and flag it, so the model sees the start
// of a huge document plus an explicit note that the tail was dropped.
export function applyDocumentMarkdownCap(markdown: string): { text: string; truncated: boolean } {
  if (markdown.length <= MAX_DOCUMENT_MARKDOWN_CHARS) {
    return { text: markdown, truncated: false };
  }
  const head = markdown.slice(0, MAX_DOCUMENT_MARKDOWN_CHARS);
  const note = `\n\n[document truncated: showing first ${MAX_DOCUMENT_MARKDOWN_CHARS} of ${markdown.length} characters]`;
  return { text: head + note, truncated: true };
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/gu, '').length;
}

// Convert one document attachment to Markdown, throwing AttachmentValidationError
// (→ HTTP 400 upstream) with user-facing copy on any failure. The real gate for
// documents is "conversion succeeds with readable text" — a file that passes
// the magic sniff but yields nothing is rejected here, not silently accepted.
export async function convertDocumentToMarkdown(dataBase64: string): Promise<string> {
  return convertDocumentBytesToMarkdown(new Uint8Array(Buffer.from(dataBase64, 'base64')));
}

/** Convert local document bytes without needlessly round-tripping through base64. */
export async function convertDocumentBytesToMarkdown(bytes: Uint8Array): Promise<string> {
  const anydoc = await loadAnydoc();

  let markdown: string;
  try {
    markdown = anydoc.toMarkdownBytes(bytes);
  } catch (error: unknown) {
    throw new AttachmentValidationError(describeConversionError(error));
  }

  if (nonWhitespaceLength(markdown) < NEAR_EMPTY_NON_WHITESPACE_CHARS) {
    throw new AttachmentValidationError(SCANNED_MESSAGE);
  }

  return applyDocumentMarkdownCap(markdown).text;
}

// Wrap converted Markdown in a clearly delimited, named block so the model can
// tell document content apart from the user's own words. Mirrors the marker
// pattern: the block rides only the live prompt, never the stored transcript.
export function buildDocumentContextBlock(name: string, markdown: string): string {
  const safeName = name.replace(/"/g, "'");
  return `<attached-document name="${safeName}">\n${markdown}\n</attached-document>`;
}
