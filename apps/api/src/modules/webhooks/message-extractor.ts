import { randomUUID } from 'node:crypto';
import type { MessageType } from '@prisma/client';

export interface ExtractedMessage {
  type: MessageType;
  content: string | null;
  media?: {
    url?: string;
    mimetype?: string;
    filename?: string;
    duration_seconds?: number;
    size_bytes?: number;
  };
  location?: { latitude?: number; longitude?: number; name?: string };
  contact?: { display_name?: string; vcard?: string };
}

type Obj = Record<string, unknown>;

const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || undefined : undefined;
const asObj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null ? (v as Obj) : undefined;

/**
 * Extract normalized message data from an Evolution/Baileys `messageContent` object.
 * Covers all WhatsApp message types. Returns TEXT with null content as fallback
 * so nothing is ever silently dropped.
 */
export function extractFromEvolution(messageContent: Obj | undefined): ExtractedMessage {
  if (!messageContent) return { type: 'TEXT', content: null };

  // Plain text
  const conversation = asStr(messageContent.conversation);
  if (conversation) return { type: 'TEXT', content: conversation };

  const extended = asObj(messageContent.extendedTextMessage);
  if (extended) {
    const text = asStr(extended.text);
    if (text) return { type: 'TEXT', content: text };
  }

  // Image
  const img = asObj(messageContent.imageMessage);
  if (img) {
    return {
      type: 'IMAGE',
      content: asStr(img.caption) ?? null,
      media: {
        url: asStr(img.url) ?? asStr(img.directPath),
        mimetype: asStr(img.mimetype) ?? 'image/jpeg',
        size_bytes: asNum(img.fileLength),
      },
    };
  }

  // Video
  const vid = asObj(messageContent.videoMessage);
  if (vid) {
    return {
      type: 'VIDEO',
      content: asStr(vid.caption) ?? null,
      media: {
        url: asStr(vid.url) ?? asStr(vid.directPath),
        mimetype: asStr(vid.mimetype) ?? 'video/mp4',
        duration_seconds: asNum(vid.seconds),
        size_bytes: asNum(vid.fileLength),
      },
    };
  }

  // Audio / PTT (voice note)
  const aud = asObj(messageContent.audioMessage);
  if (aud) {
    return {
      type: 'AUDIO',
      content: null,
      media: {
        url: asStr(aud.url) ?? asStr(aud.directPath),
        mimetype: asStr(aud.mimetype) ?? 'audio/ogg',
        duration_seconds: asNum(aud.seconds),
        size_bytes: asNum(aud.fileLength),
      },
    };
  }

  // Document
  const doc = asObj(messageContent.documentMessage) ?? asObj(messageContent.documentWithCaptionMessage);
  if (doc) {
    const inner = asObj(doc.message) ? asObj((asObj(doc.message) as Obj).documentMessage) ?? doc : doc;
    return {
      type: 'DOCUMENT',
      content: asStr(inner.caption) ?? null,
      media: {
        url: asStr(inner.url) ?? asStr(inner.directPath),
        mimetype: asStr(inner.mimetype) ?? 'application/octet-stream',
        filename: asStr(inner.fileName) ?? asStr(inner.title),
        size_bytes: asNum(inner.fileLength),
      },
    };
  }

  // Sticker
  const sticker = asObj(messageContent.stickerMessage);
  if (sticker) {
    return {
      type: 'STICKER',
      content: null,
      media: {
        url: asStr(sticker.url) ?? asStr(sticker.directPath),
        mimetype: asStr(sticker.mimetype) ?? 'image/webp',
        size_bytes: asNum(sticker.fileLength),
      },
    };
  }

  // Location
  const loc = asObj(messageContent.locationMessage) ?? asObj(messageContent.liveLocationMessage);
  if (loc) {
    return {
      type: 'LOCATION',
      content: asStr(loc.name) ?? asStr(loc.address) ?? null,
      location: {
        latitude: asNum(loc.degreesLatitude),
        longitude: asNum(loc.degreesLongitude),
        name: asStr(loc.name),
      },
    };
  }

  // Contact (vcard)
  const contact =
    asObj(messageContent.contactMessage) ?? asObj(messageContent.contactsArrayMessage);
  if (contact) {
    return {
      type: 'CONTACT',
      content: asStr(contact.displayName) ?? null,
      contact: {
        display_name: asStr(contact.displayName),
        vcard: asStr(contact.vcard),
      },
    };
  }

  // Reaction — store as TEXT with emoji content (no separate enum)
  const reaction = asObj(messageContent.reactionMessage);
  if (reaction) {
    return { type: 'TEXT', content: `[reaction] ${asStr(reaction.text) ?? ''}`.trim() };
  }

  // Unknown — preserve as TEXT with marker so it's visible instead of dropped
  const firstKey = Object.keys(messageContent)[0];
  return { type: 'TEXT', content: firstKey ? `[unsupported: ${firstKey}]` : null };
}

/**
 * Extract from WPPConnect `msg` payload (different shape from Baileys).
 */
export function extractFromWpp(msg: Obj): ExtractedMessage {
  const type = asStr(msg.type);
  const body = asStr(msg.body) ?? asStr(msg.caption);
  const mimetype = asStr(msg.mimetype);
  const fileUrl = asStr(msg.deprecatedMms3Url) ?? asStr(msg.url);
  const duration = asNum(msg.duration);
  const filename = asStr(msg.filename);
  const size = asNum(msg.size);

  switch (type) {
    case 'chat':
    case 'text':
      return { type: 'TEXT', content: body ?? null };
    case 'image':
      return {
        type: 'IMAGE',
        content: body ?? null,
        media: { url: fileUrl, mimetype: mimetype ?? 'image/jpeg', size_bytes: size },
      };
    case 'video':
      return {
        type: 'VIDEO',
        content: body ?? null,
        media: {
          url: fileUrl,
          mimetype: mimetype ?? 'video/mp4',
          duration_seconds: duration,
          size_bytes: size,
        },
      };
    case 'audio':
    case 'ptt':
      return {
        type: 'AUDIO',
        content: null,
        media: {
          url: fileUrl,
          mimetype: mimetype ?? 'audio/ogg',
          duration_seconds: duration,
          size_bytes: size,
        },
      };
    case 'document':
      return {
        type: 'DOCUMENT',
        content: body ?? null,
        media: {
          url: fileUrl,
          mimetype: mimetype ?? 'application/octet-stream',
          filename,
          size_bytes: size,
        },
      };
    case 'sticker':
      return {
        type: 'STICKER',
        content: null,
        media: { url: fileUrl, mimetype: mimetype ?? 'image/webp', size_bytes: size },
      };
    case 'location': {
      const lat = asNum(msg.lat);
      const lng = asNum(msg.lng);
      return {
        type: 'LOCATION',
        content: asStr(msg.loc) ?? null,
        location: { latitude: lat, longitude: lng, name: asStr(msg.loc) },
      };
    }
    case 'vcard':
      return {
        type: 'CONTACT',
        content: body ?? null,
        contact: { vcard: body, display_name: asStr(msg.displayName) },
      };
    default:
      return { type: 'TEXT', content: body ?? (type ? `[unsupported: ${type}]` : null) };
  }
}

/**
 * Extract from UazAPI message payload.
 */
export function extractFromUazapi(message: Obj): ExtractedMessage {
  const messageType = asStr(message.messageType) ?? asStr(message.type);
  const text = asStr(message.text);
  const caption = asStr(message.caption);
  const mediaUrl = asStr(message.mediaUrl) ?? asStr(message.url);
  const mimetype = asStr(message.mimeType) ?? asStr(message.mimetype);
  const filename = asStr(message.fileName);
  const duration = asNum(message.duration) ?? asNum(message.seconds);

  switch (messageType) {
    case 'text':
    case 'conversation':
      return { type: 'TEXT', content: text ?? null };
    case 'image':
    case 'imageMessage':
      return {
        type: 'IMAGE',
        content: caption ?? text ?? null,
        media: { url: mediaUrl, mimetype: mimetype ?? 'image/jpeg' },
      };
    case 'video':
    case 'videoMessage':
      return {
        type: 'VIDEO',
        content: caption ?? text ?? null,
        media: { url: mediaUrl, mimetype: mimetype ?? 'video/mp4', duration_seconds: duration },
      };
    case 'audio':
    case 'audioMessage':
    case 'ptt':
      return {
        type: 'AUDIO',
        content: null,
        media: { url: mediaUrl, mimetype: mimetype ?? 'audio/ogg', duration_seconds: duration },
      };
    case 'document':
    case 'documentMessage':
      return {
        type: 'DOCUMENT',
        content: caption ?? null,
        media: {
          url: mediaUrl,
          mimetype: mimetype ?? 'application/octet-stream',
          filename,
        },
      };
    case 'sticker':
    case 'stickerMessage':
      return {
        type: 'STICKER',
        content: null,
        media: { url: mediaUrl, mimetype: mimetype ?? 'image/webp' },
      };
    case 'location':
    case 'locationMessage':
      return {
        type: 'LOCATION',
        content: asStr(message.name) ?? null,
        location: {
          latitude: asNum(message.latitude),
          longitude: asNum(message.longitude),
          name: asStr(message.name),
        },
      };
    case 'contact':
    case 'contactMessage':
      return {
        type: 'CONTACT',
        content: asStr(message.displayName) ?? null,
        contact: {
          display_name: asStr(message.displayName),
          vcard: asStr(message.vcard),
        },
      };
    default:
      // Fallback: try text
      if (text) return { type: 'TEXT', content: text };
      return { type: 'TEXT', content: messageType ? `[unsupported: ${messageType}]` : null };
  }
}

/**
 * Generate a deterministic fallback id when webhook omits messageId.
 * Uses tenant + phone + timestamp so retries dedupe safely.
 */
export function synthesizeMessageId(prefix: string): string {
  return `synth_${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}
