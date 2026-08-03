import { InboundMessageService, type SaveMessageInput } from './inbound-message.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Regressão do bug de espelhamento entre vendedores (ver
 * docs/specs/conversa-por-instancia.md). O smoke
 * `scripts/smoke-conversation-routing.cjs` só valida o FORMATO dos dados —
 * ele não exercita `saveIncomingMessage`. Estes testes exercitam o método de
 * verdade, mockando Prisma e os serviços colaboradores na borda (sem banco).
 */

function makeMocks() {
  const prisma: any = {
    pipeline: { findFirst: jest.fn().mockResolvedValue({ id: 'pipe-1' }) },
    stage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-1' }) },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: false, round_robin_enabled: false }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ role: 'OPERADOR', nome: 'Fulano' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    lead: {
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    message: {
      upsert: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    notification: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const leadsService: any = {
    invalidateLeadsCache: jest.fn(),
    syncProfileSafe: jest.fn(),
  };
  const gateway: any = {
    emitLeadUnreadReset: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitNewMessage: jest.fn(),
    emitNotification: jest.fn(),
    emitMessageMediaReady: jest.fn(),
  };
  const mediaService: any = { upload: jest.fn(), getSignedUrl: jest.fn() };
  const mediaPipeline: any = {};
  const push: any = { sendToUsers: jest.fn() };
  const outboundWebhooks: any = {
    dispatchMessageCreated: jest.fn().mockResolvedValue(undefined),
  };
  const assignment: any = { resolveSectorForInstance: jest.fn(), assignBySector: jest.fn() };
  const conversations: any = {
    resolveForInbound: jest.fn(),
    syncLeadFromActive: jest.fn().mockResolvedValue(null),
    blockAi: jest.fn().mockResolvedValue(undefined),
  };
  const broadcastReply: any = {
    registerCustomerReply: jest.fn().mockResolvedValue({ replied: 0, skipped: 0 }),
  };
  return {
    prisma,
    leadsService,
    gateway,
    mediaService,
    mediaPipeline,
    push,
    outboundWebhooks,
    assignment,
    conversations,
    broadcastReply,
  };
}

function makeService() {
  const m = makeMocks();
  const service = new InboundMessageService(
    m.prisma,
    m.leadsService,
    m.gateway,
    m.mediaService,
    m.mediaPipeline,
    m.push,
    m.outboundWebhooks,
    m.assignment,
    m.conversations,
    m.broadcastReply,
  ) as InboundMessageService;
  return { service, ...m };
}

// Instância de B recebendo a mensagem. O lead já existe e pertence a A (outro
// vendedor, que atendeu o mesmo contato por OUTRO número meses atrás).
const instanceB: any = { id: 'inst-b', nome: 'inst-b', owner_user_id: 'B', sector_id: null };

const leadOwnedByA = {
  id: 'lead-1',
  nome: 'Cliente',
  telefone: '5511900000000',
  responsavel_id: 'A',
  instancia_whatsapp: 'inst-a',
  foto_url: 'https://x.com/foto.jpg',
};

function baseInput(overrides: Partial<SaveMessageInput> = {}): SaveMessageInput {
  return {
    tenantId: 't1',
    instance: instanceB,
    phone: '5511900000000',
    messageId: 'wa-msg-1',
    isFromMe: false,
    extracted: { type: 'TEXT', content: 'oi, voltei' } as any,
    rawPayload: {},
    ...overrides,
  };
}

describe('InboundMessageService.saveIncomingMessage — roteamento por conversa', () => {
  it('C1: resolveForInbound recebe defaultResponsavelId = dono da instância (B), NÃO o dono do lead (A)', async () => {
    // Regressão direta do bug do brief original: `defaultResponsavelId:
    // lead.responsavel_id ?? responsavelId` avaliava para 'A' neste cenário
    // (lead já tem dono A; responsavelId/B só entraria como fallback). Com o
    // operando invertido (`responsavelId ?? lead.responsavel_id`), fica 'B'.
    // Rodado contra o código PRÉ-fix (operandos na ordem antiga), esta
    // asserção falha: 'A' !== 'B'. Ver relato no report — verificado por
    // raciocínio (upsert do lead cai no branch update quando o lead já
    // existe, então lead.responsavel_id permanece 'A'; instance.owner_user_id
    // é 'B' → responsavelId = 'B'; `lead.responsavel_id ?? responsavelId`
    // descarta 'B' porque 'A' não é null/undefined).
    const { service, prisma, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(conversations.resolveForInbound).toHaveBeenCalledWith(
      expect.objectContaining({ defaultResponsavelId: 'B' }),
    );
  });

  it('grava a mensagem com conversation_id e visible_to_user_id da CONVERSA (B), não do lead (A)', async () => {
    const { service, prisma, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    const upsertArgs = prisma.message.upsert.mock.calls[0][0];
    expect(upsertArgs.create.conversation_id).toBe('conv-b');
    expect(upsertArgs.create.visible_to_user_id).toBe('B');
  });

  it('NÃO chama syncLeadFromActive quando isFromMe=true (envio não move o card)', async () => {
    const { service, prisma, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA, responsavel_id: 'B' });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput({ isFromMe: true }));

    expect(conversations.syncLeadFromActive).not.toHaveBeenCalled();
  });

  it('chama blockAi com o id da CONVERSA quando isFromMe=true (trava a IA só nesta conversa)', async () => {
    const { service, prisma, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA, responsavel_id: 'B' });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput({ isFromMe: true }));

    expect(conversations.blockAi).toHaveBeenCalledWith('conv-b', 'lead-1');
  });

  it('emite o patch RETORNADO por syncLeadFromActive, não os valores de `conversation`/`instance` computados antes (I2)', async () => {
    // syncLeadFromActive devolve um dono/instância DIVERGENTE do que o
    // código pré-I2 emitia (`conversation.responsavel_id` = 'B',
    // `instance.nome` = 'inst-b'): aqui a conversa ativa RE-DERIVADA dentro
    // da transação é 'C'/'inst-c' — cenário de mensagem concorrente chegando
    // por uma TERCEIRA instância enquanto esta era processada. Se o emit
    // ainda usasse os valores pré-sync (implementação antiga), a asserção
    // abaixo falharia: ela receberia 'B'/'inst-b', não 'C'/'inst-c'.
    const { service, prisma, gateway, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    conversations.syncLeadFromActive.mockResolvedValue({
      responsavel_id: 'C',
      instancia_whatsapp: 'inst-c',
    });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(conversations.syncLeadFromActive).toHaveBeenCalledWith('lead-1');
    expect(gateway.emitLeadUpdated).toHaveBeenCalledWith(
      'lead-1',
      { responsavel_id: 'C', instancia_whatsapp: 'inst-c' },
      't1',
    );
  });

  it('não emite emitLeadUpdated quando syncLeadFromActive retorna null (falhou ou nada mudou) (I2)', async () => {
    const { service, prisma, gateway, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    conversations.syncLeadFromActive.mockResolvedValue(null);
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(gateway.emitLeadUpdated).not.toHaveBeenCalled();
  });

  it('pula a sincronização quando o lead já reflete a conversa (I4 — evita transação/emit no-op)', async () => {
    const { service, prisma, conversations } = makeService();
    // lead já aponta pro dono e instância certos — nada pra sincronizar.
    prisma.lead.upsert.mockResolvedValue({
      ...leadOwnedByA,
      responsavel_id: 'B',
      instancia_whatsapp: 'inst-b',
    });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(conversations.syncLeadFromActive).not.toHaveBeenCalled();
  });

  it('notificações usam o dono da CONVERSA (B), não o dono do lead (A) (I1)', async () => {
    const { service, prisma, push, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(push.sendToUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['B']),
      expect.anything(),
    );
    expect(push.sendToUsers).not.toHaveBeenCalledWith(
      expect.arrayContaining(['A']),
      expect.anything(),
    );
  });

  it('mensagem do cliente registra a resposta no follow-up', async () => {
    const { service, prisma, conversations, broadcastReply } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(broadcastReply.registerCustomerReply).toHaveBeenCalledWith('lead-1');
  });

  it('mensagem do vendedor NÃO registra resposta', async () => {
    const { service, prisma, conversations, broadcastReply } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA, responsavel_id: 'B' });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput({ isFromMe: true }));

    expect(broadcastReply.registerCustomerReply).not.toHaveBeenCalled();
  });
});
