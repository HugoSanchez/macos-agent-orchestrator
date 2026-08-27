import { describe, expect, it } from 'vitest';
import {
  AttachmentValidationError,
  MAX_ATTACHMENT_COUNT,
  appendAttachmentMarkers,
  parseChatAttachments,
} from '../src/chat/attachments.ts';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
]);
const GIF_BYTES = Buffer.from('GIF89a', 'latin1');
const PDF_BYTES = Buffer.from('%PDF-1.4 not an image', 'latin1');
const DOCX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('word/document.xml payload', 'latin1'),
]);
const PPTX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('ppt/presentation.xml payload', 'latin1'),
]);
const OLE_BYTES = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('legacy office', 'latin1'),
]);
const GARBAGE_BYTES = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);

function bodyWith(attachments: unknown): unknown {
  return { content: 'hello', attachments };
}

describe('parseChatAttachments', () => {
  it('returns empty for a body without attachments', () => {
    expect(parseChatAttachments({ content: 'hi' })).toEqual([]);
    expect(parseChatAttachments(null)).toEqual([]);
  });

  it('accepts each supported image format, sniffing the mime type', () => {
    const cases: Array<[Buffer, string]> = [
      [PNG_BYTES, 'image/png'],
      [JPEG_BYTES, 'image/jpeg'],
      [WEBP_BYTES, 'image/webp'],
      [GIF_BYTES, 'image/gif'],
    ];
    for (const [bytes, expectedMime] of cases) {
      const parsed = parseChatAttachments(bodyWith([
        // Declared mime is deliberately wrong — the sniffed type must win.
        { name: 'shot.bin', mimeType: 'application/octet-stream', dataBase64: bytes.toString('base64') },
      ]));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].mimeType).toBe(expectedMime);
      expect(parsed[0].name).toBe('shot.bin');
    }
  });

  it('routes documents by magic bytes, marking kind and a coarse mime', () => {
    const cases: Array<[Buffer, string]> = [
      [PDF_BYTES, 'application/pdf'],
      [DOCX_BYTES, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      [PPTX_BYTES, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      [OLE_BYTES, 'application/x-ole-storage'],
    ];
    for (const [bytes, expectedMime] of cases) {
      const parsed = parseChatAttachments(bodyWith([
        // Declared mime deliberately wrong — the magic sniff must win.
        { name: 'doc.png', mimeType: 'image/png', dataBase64: bytes.toString('base64') },
      ]));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].kind).toBe('document');
      expect(parsed[0].mimeType).toBe(expectedMime);
    }
  });

  it('tags images with kind "image"', () => {
    const parsed = parseChatAttachments(bodyWith([
      { name: 'shot.png', dataBase64: PNG_BYTES.toString('base64') },
    ]));
    expect(parsed[0].kind).toBe('image');
  });

  it('rejects bytes matching no supported image or document type', () => {
    expect(() => parseChatAttachments(bodyWith([
      { name: 'mystery.bin', mimeType: 'application/octet-stream', dataBase64: GARBAGE_BYTES.toString('base64') },
    ]))).toThrow(AttachmentValidationError);
  });

  it('rejects an oversize document above the 10MB document cap', () => {
    const bigDoc = Buffer.concat([Buffer.from('%PDF-', 'latin1'), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    expect(() => parseChatAttachments(bodyWith([
      { name: 'huge.pdf', dataBase64: bigDoc.toString('base64') },
    ]))).toThrow(/Document exceeds 10MB/);
  });

  it('rejects missing or invalid base64 data', () => {
    expect(() => parseChatAttachments(bodyWith([{ name: 'a.png' }])))
      .toThrow(AttachmentValidationError);
    expect(() => parseChatAttachments(bodyWith([{ name: 'a.png', dataBase64: '$$$not-base64$$$' }])))
      .toThrow(AttachmentValidationError);
    expect(() => parseChatAttachments(bodyWith([{
      name: 'a.png',
      dataBase64: `${PNG_BYTES.toString('base64')}!`,
    }])))
      .toThrow(AttachmentValidationError);
  });

  it('rejects non-array attachments and too many attachments', () => {
    expect(() => parseChatAttachments(bodyWith('nope'))).toThrow(AttachmentValidationError);
    const entry = { name: 'a.png', dataBase64: PNG_BYTES.toString('base64') };
    const tooMany = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => entry);
    expect(() => parseChatAttachments(bodyWith(tooMany))).toThrow(AttachmentValidationError);
  });

  it('rejects oversized attachments', () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    expect(() => parseChatAttachments(bodyWith([
      { name: 'big.png', dataBase64: big.toString('base64') },
    ]))).toThrow(/5MB/);
  });

  it('sanitizes names so markers stay parseable', () => {
    const parsed = parseChatAttachments(bodyWith([
      { name: '  [weird]\u0000name.png ', dataBase64: PNG_BYTES.toString('base64') },
      { name: '', dataBase64: PNG_BYTES.toString('base64') },
    ]));
    expect(parsed[0].name).toBe('weirdname.png');
    expect(parsed[1].name).toBe('image');
  });
});

describe('appendAttachmentMarkers', () => {
  const image = { name: 'shot.png', mimeType: 'image/png', dataBase64: 'x', kind: 'image' as const };
  const document = { name: 'report.pdf', mimeType: 'application/pdf', dataBase64: 'y', kind: 'document' as const };

  it('appends one marker line per attachment after the text', () => {
    expect(appendAttachmentMarkers('look at this', [image]))
      .toBe('look at this\n\n[attached image: shot.png]');
  });

  it('uses a distinct marker for documents', () => {
    expect(appendAttachmentMarkers('read this', [document]))
      .toBe('read this\n\n[attached document: report.pdf]');
  });

  it('mixes image and document markers in attachment order', () => {
    expect(appendAttachmentMarkers('both', [image, document]))
      .toBe('both\n\n[attached image: shot.png]\n[attached document: report.pdf]');
  });

  it('returns markers alone for attachment-only messages', () => {
    expect(appendAttachmentMarkers('', [image])).toBe('[attached image: shot.png]');
  });

  it('leaves text untouched without attachments', () => {
    expect(appendAttachmentMarkers('plain', [])).toBe('plain');
  });
});
