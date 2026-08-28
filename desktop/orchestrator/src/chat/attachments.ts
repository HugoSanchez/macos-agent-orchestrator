// Attachments for chat messages: images and documents.
//
// The chat-ui posts `attachments: [{ name, mimeType, dataBase64 }]` alongside
// `content`. We validate by magic bytes (the browser-declared MIME type is
// advisory) and persist a plain-text marker line per attachment inside the
// stored message content. Markers — not blobs — are what survive restarts and
// history rebuilds, so the transcript always shows that a message carried
// attachments without the DB ever holding the raw bytes.
//
// The two kinds diverge only on how they reach Hermes: images ride the live
// request as `input_image` content parts; documents are converted to Markdown
// locally (see document-conversion.ts) and injected into the prompt text,
// because Hermes' chat API rejects file/input_file parts.

export type AttachmentKind = 'image' | 'document';

export interface ChatAttachment {
  name: string;
  /** Sniffed from magic bytes, never trusted from the client. */
  mimeType: string;
  dataBase64: string;
  /** How this attachment reaches the model — routed by magic-byte sniff. */
  kind: AttachmentKind;
}

export const MAX_ATTACHMENT_COUNT = 6;
// Images stay lean (they ride the wire base64-inflated); documents get more
// headroom since they're converted to text before reaching the model.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class AttachmentValidationError extends Error {}

const UNSUPPORTED_MESSAGE =
  'Only images (PNG, JPEG, WebP, GIF) and documents (PDF, Word, PowerPoint) are supported';
const INVALID_BASE64_CHAR = /[^A-Za-z0-9+/=]/;

/** Must stay in sync with the marker parsing in chat-ui (MessageList.tsx). */
export function attachmentMarker(name: string, kind: AttachmentKind): string {
  return kind === 'document' ? `[attached document: ${name}]` : `[attached image: ${name}]`;
}

export function appendAttachmentMarkers(text: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return text;
  const markers = attachments
    .map((attachment) => attachmentMarker(attachment.name, attachment.kind))
    .join('\n');
  return text ? `${text}\n\n${markers}` : markers;
}

export function parseChatAttachments(body: unknown): ChatAttachment[] {
  const raw = (body as { attachments?: unknown } | null)?.attachments;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new AttachmentValidationError('"attachments" must be an array');
  }
  if (raw.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentValidationError(`Too many attachments (max ${MAX_ATTACHMENT_COUNT})`);
  }

  let totalBytes = 0;
  const attachments: ChatAttachment[] = [];
  for (const entry of raw) {
    const record = entry as { name?: unknown; dataBase64?: unknown } | null;
    const dataBase64 = typeof record?.dataBase64 === 'string' ? record.dataBase64 : '';
    if (!dataBase64) {
      throw new AttachmentValidationError('Each attachment needs base64 data');
    }

    // Buffer.from(..., 'base64') silently ignores invalid characters, so
    // validate the encoded form before decoding it.
    if (!isBase64(dataBase64)) {
      throw new AttachmentValidationError('Attachment data is not valid base64');
    }
    const bytes = Buffer.from(dataBase64, 'base64');

    const sniffed = sniffAttachment(bytes);
    if (!sniffed) {
      throw new AttachmentValidationError(UNSUPPORTED_MESSAGE);
    }

    const perFileLimit = sniffed.kind === 'document' ? MAX_DOCUMENT_BYTES : MAX_ATTACHMENT_BYTES;
    if (bytes.length > perFileLimit) {
      const noun = sniffed.kind === 'document' ? 'Document' : 'Image';
      throw new AttachmentValidationError(
        `${noun} exceeds ${Math.round(perFileLimit / (1024 * 1024))}MB limit`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachments exceed ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))}MB total limit`,
      );
    }

    attachments.push({
      name: sanitizeAttachmentName(record?.name, sniffed.kind),
      mimeType: sniffed.mimeType,
      dataBase64,
      kind: sniffed.kind,
    });
  }

  return attachments;
}

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0 || INVALID_BASE64_CHAR.test(value)) return false;
  const padding = value.indexOf('=');
  return padding === -1
    || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding)));
}

// Marker lines use square brackets, so strip them (plus control chars) from
// names to keep the stored marker parseable.
function sanitizeAttachmentName(value: unknown, kind: AttachmentKind): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.replace(/[[\]\p{Cc}]/gu, '').trim().slice(0, 120);
  return cleaned || (kind === 'document' ? 'document' : 'image');
}

interface SniffResult {
  mimeType: string;
  kind: AttachmentKind;
}

// Route by magic bytes. Images resolve to a precise MIME (needed for the
// `input_image` data URL); documents resolve to a coarse type — anydoc's own
// content detection is the authority on the exact document format, and the
// real gate is whether conversion succeeds.
function sniffAttachment(bytes: Buffer): SniffResult | null {
  const imageMime = sniffImageMime(bytes);
  if (imageMime) return { mimeType: imageMime, kind: 'image' };

  const documentMime = sniffDocumentMime(bytes);
  if (documentMime) return { mimeType: documentMime, kind: 'document' };

  return null;
}

function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'GIF8') {
    return 'image/gif';
  }
  return null;
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function sniffDocumentMime(bytes: Buffer): string | null {
  // PDF: `%PDF-`.
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  // OOXML (docx/pptx): a ZIP container (`PK\x03\x04`). Peek at the archive's
  // part names to distinguish Word from PowerPoint for a precise MIME; when
  // neither part is found we still accept the ZIP as a generic document and let
  // anydoc's content detection be the authority (and reject at conversion if it
  // turns out to be an unsupported archive).
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return sniffOoxmlMime(bytes);
  }
  // Legacy Office (doc/ppt): OLE/CFB compound file. `D0 CF 11 E0 A1 B1 1A E1`.
  // Word vs PowerPoint lives in the OLE directory streams, which anydoc reads;
  // we just recognize the container here.
  if (
    bytes.length >= 8
    && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
    && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1
  ) {
    return 'application/x-ole-storage';
  }
  return null;
}

const GENERIC_OOXML_MIME = 'application/zip';

// OOXML part names appear as plain ASCII in the ZIP file headers, so a byte
// substring scan tells docx (`word/`) from pptx (`ppt/`) without a full ZIP
// parse. Media-heavy packages can push the main part past any small prefix, so
// scan the whole buffer; when the tell-tale part isn't found we still accept
// the ZIP generically and let anydoc decide the format.
function sniffOoxmlMime(bytes: Buffer): string {
  if (bytes.includes(Buffer.from('word/'))) return DOCX_MIME;
  if (bytes.includes(Buffer.from('ppt/'))) return PPTX_MIME;
  return GENERIC_OOXML_MIME;
}
