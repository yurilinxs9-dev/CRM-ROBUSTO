type Obj = Record<string, unknown>;

export type AckStatus = 'DELIVERED' | 'READ' | 'FAILED';

export interface NormalizedAck {
  messageId: string;
  status: AckStatus;
}

/**
 * Normaliza o payload de `messages.update` para uma lista de updates.
 *
 * Evolution v2 envia `data` como OBJETO flat ({ keyId, status, ... });
 * o shape Baileys/wppconnect antigo era um ARRAY de { key:{id}, update:{status} }.
 * Sem normalizar, o objeto flat caía no `!Array.isArray` e TODOS os acks de
 * entrega/leitura eram descartados (outbound preso em SENT, ERROR invisível).
 */
export function normalizeAckUpdates(raw: unknown): Obj[] {
  if (Array.isArray(raw)) return raw as Obj[];
  if (raw && typeof raw === 'object') return [raw as Obj];
  return [];
}

const STATUS_MAP: Record<string, AckStatus> = {
  DELIVERY_ACK: 'DELIVERED',
  READ: 'READ',
  PLAYED: 'READ',
  ERROR: 'FAILED',
};

/**
 * Extrai { messageId, status } de um update em qualquer dos dois shapes.
 * Retorna null quando faltar id/status ou o status não mapear (ex.: PENDING).
 */
export function extractAck(update: Obj): NormalizedAck | null {
  const key = update?.key as Obj | undefined;
  const messageId =
    (key?.id as string | undefined) ?? (update?.keyId as string | undefined);
  const updateData = update?.update as Obj | undefined;
  const status =
    (updateData?.status as string | undefined) ??
    (update?.status as string | undefined);
  if (!messageId || !status) return null;

  const mapped = STATUS_MAP[status];
  if (!mapped) return null;
  return { messageId, status: mapped };
}
