import { resolveActiveConversation, type ConversationSnapshot } from '@/modules/webhooks/conversation-routing';

const conv = (id: string, inst: string, dono: string | null, ultima: string | null): ConversationSnapshot => ({
  id, instancia_whatsapp: inst, responsavel_id: dono,
  last_customer_message_at: ultima ? new Date(ultima) : null,
});

describe('transferência de lead — qual conversa muda de dono', () => {
  it('escolhe a conversa ativa, não a do destinatário', () => {
    const daVendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z');
    const doAlex = conv('c2', 'inst-alex', 'u-alex', '2026-03-01T10:00:00Z');
    // Cliente falou por último no número da vendedora. Transferir pro Alex tem
    // que mexer em c1 — senão a próxima mensagem reverte a transferência.
    expect(resolveActiveConversation([daVendedora, doAlex])?.id).toBe('c1');
  });

  it('lead sem conversa nenhuma não tem o que transferir', () => {
    expect(resolveActiveConversation([])).toBeNull();
  });
});
