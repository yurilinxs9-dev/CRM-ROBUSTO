/**
 * Quem mandou cada mensagem de saída — legenda "Enviada por …" que o chat
 * mostra só para gerente/admin. Pedido da Ferbraço (nov/2026): o mesmo cliente
 * conversava com o Thiago, o Yago e o Bruno, cada um do próprio número, e no
 * chat unificado (share_history) não dava para saber quem tinha escrito o quê.
 *
 * Sem Prisma aqui: quem chama resolve nomes de usuário e donos de instância.
 */
export type MessageSenderOrigin = 'crm' | 'celular' | 'ia' | 'automacao';

export interface MessageSender {
  name: string | null;
  origin: MessageSenderOrigin;
}

export interface MessageSenderInput {
  direction: string;
  is_internal_note: boolean;
  sender_type: string;
  sent_by_user_id: string | null;
  instance_name: string;
}

export interface MessageSenderLookup {
  userNames: ReadonlyMap<string, string>;
  /** instance_name → nome do dono do número. */
  instanceOwnerNames: ReadonlyMap<string, string>;
}

export function resolveMessageSender(
  msg: MessageSenderInput,
  lookup: MessageSenderLookup,
): MessageSender | null {
  // Mensagem do cliente não tem "quem enviou"; nota interna já mostra o autor
  // no próprio card.
  if (msg.direction !== 'OUTGOING' || msg.is_internal_note) return null;
  if (msg.sender_type === 'ai') return { name: null, origin: 'ia' };
  // 'system' = API pública / n8n / follow-up: o sent_by_user_id é o dono da
  // chave, não alguém que digitou — mostrar o nome dele enganaria.
  if (msg.sender_type === 'system') return { name: null, origin: 'automacao' };
  if (msg.sent_by_user_id) {
    return { name: lookup.userNames.get(msg.sent_by_user_id) ?? null, origin: 'crm' };
  }
  // Enviada do celular (fromMe pelo webhook): não há usuário no registro, só o
  // número. Atribuímos ao dono do número.
  return { name: lookup.instanceOwnerNames.get(msg.instance_name) ?? null, origin: 'celular' };
}
