export const MESSAGES_SEND_QUEUE = 'messages-send';

export type SendMessageJobName = 'send-text' | 'send-audio' | 'send-media';

interface JobBase {
  messageId: string;
  leadId: string;
  tenantId: string;
  instanceName: string;
  telefone: string;
  uazBaseUrl: string;
  uazToken: string;
}

export interface SendTextJobData extends JobBase {
  kind: 'text';
  content: string;
}

export interface SendAudioJobData extends JobBase {
  kind: 'audio';
  storagePath: string;
  signedUrl: string;
  durationSeconds: number | undefined;
}

export interface SendMediaJobData extends JobBase {
  kind: 'media';
  storagePath: string;
  signedUrl: string;
  mimetype: string;
  mediaType: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  filename?: string;
}

export type SendMessageJobData = SendTextJobData | SendAudioJobData | SendMediaJobData;
