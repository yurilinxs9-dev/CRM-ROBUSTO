import { createDecipheriv, createHmac, hkdfSync } from 'crypto';

/**
 * WhatsApp E2E media decryption.
 *
 * WhatsApp serves media encrypted with AES-256-CBC. The webhook payload
 * provides a `mediaKey` (base64, 32 bytes) which is expanded via HKDF-SHA256
 * into IV (16B) + cipherKey (32B) + macKey (32B) + refKey (32B) = 112 bytes.
 *
 * The encrypted file format: [ciphertext] + [10 bytes HMAC-SHA256 MAC]
 * After decryption, PKCS#7 padding is stripped manually.
 *
 * Reference: Baileys / libsignal-protocol
 */

type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker';

const INFO_BY_TYPE: Record<MediaType, string> = {
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker: 'WhatsApp Image Keys',
};

/**
 * Decrypt WhatsApp media that was downloaded from the CDN (mmg.whatsapp.net).
 *
 * @param encrypted  Raw encrypted buffer (includes 10-byte MAC suffix)
 * @param mediaKeyB64  Base64-encoded 32-byte media key from webhook
 * @param type  Media type (determines HKDF info string)
 * @returns Decrypted plaintext buffer (valid audio/image/video/etc.)
 */
export function decryptWhatsAppMedia(
  encrypted: Buffer,
  mediaKeyB64: string,
  type: MediaType,
): Buffer {
  const mediaKey = Buffer.from(mediaKeyB64, 'base64');
  const info = INFO_BY_TYPE[type];

  // HKDF-SHA256: extract+expand (salt = empty, output = 112 bytes)
  const expanded = Buffer.from(hkdfSync('sha256', mediaKey, Buffer.alloc(0), info, 112));

  const iv = expanded.slice(0, 16);
  const cipherKey = expanded.slice(16, 48);
  // macKey = expanded.slice(48, 80); — used for MAC verification (skipped here)
  // refKey = expanded.slice(80, 112); — unused

  // Strip 10-byte HMAC MAC from end
  const ciphertext = encrypted.slice(0, encrypted.length - 10);

  // AES-256-CBC decrypt (no auto-padding — handle PKCS#7 manually)
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Strip PKCS#7 padding
  const padLen = decrypted[decrypted.length - 1];
  if (padLen > 0 && padLen <= 16) {
    return decrypted.slice(0, decrypted.length - padLen);
  }
  return decrypted;
}

/**
 * Map message type string to crypto media type.
 */
export function messageTypeToMediaType(type: string): MediaType {
  switch (type.toUpperCase()) {
    case 'IMAGE':    return 'image';
    case 'VIDEO':    return 'video';
    case 'AUDIO':    return 'audio';
    case 'DOCUMENT': return 'document';
    case 'STICKER':  return 'sticker';
    default:         return 'document';
  }
}

// ── Magic bytes validation ─────────────────────────────────────────────────────

const MAGIC_BYTES: Record<string, { offset: number; signatures: number[][] }> = {
  'audio/ogg':           { offset: 0, signatures: [[0x4f, 0x67, 0x67, 0x53]] },                       // OggS
  'audio/mpeg':          { offset: 0, signatures: [[0xff, 0xfb], [0xff, 0xf3], [0x49, 0x44, 0x33]] }, // MP3 / ID3
  'audio/mp4':           { offset: 4, signatures: [[0x66, 0x74, 0x79, 0x70]] },                       // ftyp
  'image/jpeg':          { offset: 0, signatures: [[0xff, 0xd8, 0xff]] },
  'image/png':           { offset: 0, signatures: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/webp':          { offset: 0, signatures: [[0x52, 0x49, 0x46, 0x46]] },                       // RIFF
  'image/gif':           { offset: 0, signatures: [[0x47, 0x49, 0x46, 0x38]] },                       // GIF8
  'video/mp4':           { offset: 4, signatures: [[0x66, 0x74, 0x79, 0x70]] },                       // ftyp
  'video/webm':          { offset: 0, signatures: [[0x1a, 0x45, 0xdf, 0xa3]] },                       // EBML
  'application/pdf':     { offset: 0, signatures: [[0x25, 0x50, 0x44, 0x46]] },                       // %PDF
};

/**
 * Validate that the buffer starts with expected magic bytes for the given mimetype.
 * Throws if the magic bytes don't match (likely encrypted/corrupted data).
 * No-ops for unknown mimetypes (so we don't block unsupported formats).
 */
export function assertValidMagic(buf: Buffer, mimetype: string, messageId: string): void {
  const base = mimetype.split(';')[0].trim().toLowerCase();
  const entry = MAGIC_BYTES[base];
  if (!entry) return; // Unknown mimetype — don't block

  const ok = entry.signatures.some((sig) =>
    sig.every((b, i) => buf[entry.offset + i] === b),
  );

  if (!ok) {
    const got = buf.slice(0, 16).toString('hex');
    throw new Error(
      `Media magic bytes invalidos msg=${messageId} mime=${base} ` +
      `size=${buf.length} got=${got}. Provavel payload criptografado.`,
    );
  }
}
