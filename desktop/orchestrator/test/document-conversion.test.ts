import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_MARKDOWN_CHARS,
  applyDocumentMarkdownCap,
  buildDocumentContextBlock,
  convertDocumentToMarkdown,
  describeConversionError,
} from '../src/chat/document-conversion.ts';
import { AttachmentValidationError } from '../src/chat/attachments.ts';
import { makeMinimalPdf, makeTextlessPdf } from './fixtures/documents.ts';

describe('document conversion', () => {
  it('converts a real one-page PDF to Markdown end-to-end', async () => {
    const pdf = makeMinimalPdf('Quarterly Verso Report');
    const markdown = await convertDocumentToMarkdown(pdf.toString('base64'));
    expect(markdown).toContain('Quarterly Verso Report');
  });

  it('rejects a scanned / image-only PDF with a friendly message', async () => {
    const pdf = makeTextlessPdf();
    await expect(convertDocumentToMarkdown(pdf.toString('base64')))
      .rejects.toBeInstanceOf(AttachmentValidationError);
    await expect(convertDocumentToMarkdown(pdf.toString('base64')))
      .rejects.toThrow(/scanned or image-only/i);
  });

  it('rejects unreadable bytes that slip past the magic sniff', async () => {
    // `%PDF-` header but a garbage body: passes the sniff, fails conversion.
    const fake = Buffer.from('%PDF-1.4 this is not really a pdf', 'latin1');
    await expect(convertDocumentToMarkdown(fake.toString('base64')))
      .rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it('maps the anydoc error taxonomy onto user-facing copy', () => {
    expect(describeConversionError(Object.assign(new Error('locked'), { code: 'encrypted' })))
      .toMatch(/password-protected/i);
    expect(describeConversionError(
      Object.assign(new Error('PDF has no extractable text: OCR is required'), { code: 'unsupported' }),
    )).toMatch(/scanned or image-only/i);
    expect(describeConversionError(Object.assign(new Error('nope'), { code: 'malformed' })))
      .toMatch(/couldn't read/i);
    expect(describeConversionError(Object.assign(new Error('nope'), { code: 'unsupported' })))
      .toMatch(/couldn't read/i);
  });

  it('caps over-long Markdown and flags the truncation', () => {
    const long = 'a'.repeat(MAX_DOCUMENT_MARKDOWN_CHARS + 500);
    const { text, truncated } = applyDocumentMarkdownCap(long);
    expect(truncated).toBe(true);
    expect(text).toContain(`showing first ${MAX_DOCUMENT_MARKDOWN_CHARS}`);
    expect(text.startsWith('a'.repeat(MAX_DOCUMENT_MARKDOWN_CHARS))).toBe(true);
  });

  it('leaves short Markdown untouched', () => {
    const { text, truncated } = applyDocumentMarkdownCap('short body');
    expect(truncated).toBe(false);
    expect(text).toBe('short body');
  });

  it('wraps Markdown in a delimited, named block', () => {
    const block = buildDocumentContextBlock('report.pdf', '# Heading');
    expect(block).toBe('<attached-document name="report.pdf">\n# Heading\n</attached-document>');
  });
});
