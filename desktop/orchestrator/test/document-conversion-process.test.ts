import { describe, expect, it } from 'vitest';
import { parseDocumentWorkerOutput } from '../src/chat/document-conversion-process.ts';

describe('document conversion worker protocol', () => {
  it('accepts a complete conversion result independently of worker exit status', () => {
    expect(parseDocumentWorkerOutput('ok\n# Extracted document')).toEqual({
      ok: true,
      markdown: '# Extracted document',
    });
  });

  it('surfaces framed conversion errors', () => {
    expect(parseDocumentWorkerOutput('error\nCould not read document')).toEqual({
      ok: false,
      message: 'Could not read document',
    });
  });
});
