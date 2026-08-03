import {
  resolveActiveConversation,
  buildLeadSyncPatch,
  type ConversationSnapshot,
} from './conversation-routing';

const conv = (
  id: string,
  instancia: string,
  responsavel: string | null,
  lastCustomer: string | null,
): ConversationSnapshot => ({
  id,
  instancia_whatsapp: instancia,
  responsavel_id: responsavel,
  last_customer_message_at: lastCustomer ? new Date(lastCustomer) : null,
});

describe('resolveActiveConversation', () => {
  it('lista vazia devolve null', () => {
    expect(resolveActiveConversation([])).toBeNull();
  });

  it('conversa única é a ativa mesmo sem mensagem do cliente', () => {
    const a = conv('c1', 'inst-vendedora', 'u-vendedora', null);
    expect(resolveActiveConversation([a])?.id).toBe('c1');
  });

  it('BUG CAJURU: cliente falou por último com o Alex, então a conversa dele é a ativa', () => {
    const vendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-03-10T12:00:00Z');
    const alex = conv('c2', 'inst-alex', 'u-alex', '2026-08-03T09:00:00Z');
    expect(resolveActiveConversation([vendedora, alex])?.id).toBe('c2');
  });

  it('ordem da lista não altera o resultado', () => {
    const vendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-03-10T12:00:00Z');
    const alex = conv('c2', 'inst-alex', 'u-alex', '2026-08-03T09:00:00Z');
    expect(resolveActiveConversation([alex, vendedora])?.id).toBe('c2');
  });

  it('conversa sem mensagem do cliente perde para qualquer uma que tenha', () => {
    const semCliente = conv('c1', 'inst-a', 'u-a', null);
    const comCliente = conv('c2', 'inst-b', 'u-b', '2026-01-01T00:00:00Z');
    expect(resolveActiveConversation([semCliente, comCliente])?.id).toBe('c2');
  });

  it('empate exato desempata por id, de forma determinística', () => {
    const a = conv('c2', 'inst-a', 'u-a', '2026-08-03T09:00:00Z');
    const b = conv('c1', 'inst-b', 'u-b', '2026-08-03T09:00:00Z');
    expect(resolveActiveConversation([a, b])?.id).toBe('c1');
    expect(resolveActiveConversation([b, a])?.id).toBe('c1');
  });

  it('todas sem mensagem do cliente: desempata por id', () => {
    const a = conv('c2', 'inst-a', 'u-a', null);
    const b = conv('c1', 'inst-b', 'u-b', null);
    expect(resolveActiveConversation([a, b])?.id).toBe('c1');
  });
});

describe('buildLeadSyncPatch', () => {
  it('devolve o dono e a instância da conversa ativa', () => {
    const vendedora = conv('c1', 'inst-vendedora', 'u-vendedora', '2026-03-10T12:00:00Z');
    const alex = conv('c2', 'inst-alex', 'u-alex', '2026-08-03T09:00:00Z');
    expect(buildLeadSyncPatch([vendedora, alex])).toEqual({
      responsavel_id: 'u-alex',
      instancia_whatsapp: 'inst-alex',
    });
  });

  it('conversa ativa sem dono propaga null (lead volta pro pool)', () => {
    const a = conv('c1', 'inst-a', null, '2026-08-03T09:00:00Z');
    expect(buildLeadSyncPatch([a])).toEqual({
      responsavel_id: null,
      instancia_whatsapp: 'inst-a',
    });
  });

  it('sem conversa nenhuma devolve null — chamador não deve tocar no lead', () => {
    expect(buildLeadSyncPatch([])).toBeNull();
  });
});
