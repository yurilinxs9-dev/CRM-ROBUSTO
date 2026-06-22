export const MESSAGES_SEND_QUEUE = 'messages-send';

export type SendMessageJobName = 'send-text' | 'send-audio' | 'send-media';

interface JobBase {
  messageId: string;
  leadId: string;
  tenantId: string;
  instanceName: string;
  telefone: string;
  /**
   * Gateway de WhatsApp. Ausente = 'uazapi' (retrocompatível com jobs antigos
   * enfileirados antes da migração). 'evolution' usa o adapter Evolution API.
   */
  provider?: 'uazapi' | 'evolution';
  // UazAPI: base global + token por instância (header `token`).
  uazBaseUrl?: string;
  uazToken?: string;
  // Evolution: base do servidor + apikey da instância (header `apikey`);
  // o nome da instância (instanceName) entra na URL.
  evoBaseUrl?: string;
  evoApiKey?: string;
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
