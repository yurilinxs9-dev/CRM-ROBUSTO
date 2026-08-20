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
  const attribution: any = {
    extractClickCode: jest.fn().mockReturnValue(null),
    consumeClick: jest.fn().mockResolvedValue(null),
    fromAdReferral: jest.fn().mockReturnValue({}),
    recordFirstTouch: jest.fn().mockResolvedValue(undefined),
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
    attribution,
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
    m.attribution,
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

    expect(broadcastReply.registerCustomerReply).toHaveBeenCalledWith('lead-1', 't1');
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

describe('InboundMessageService.saveIncomingMessage — modo backfill (history sync)', () => {
  const OLD_TS = new Date('2026-08-16T12:00:00.000Z'); // dentro do buraco 15-17/ago
  const setupHappyPath = (m: ReturnType<typeof makeService>) => {
    m.prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    m.conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    m.prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
      metadata: {},
    });
  };

  it('backfill grava created_at do message e ultima_interacao do lead com o timestamp ORIGINAL', async () => {
    const m = makeService();
    setupHappyPath(m);

    await m.service.saveIncomingMessage(baseInput({ backfill: { timestamp: OLD_TS } }));

    const leadArgs = m.prisma.lead.upsert.mock.calls[0][0];
    expect(leadArgs.create.ultima_interacao).toEqual(OLD_TS);
    expect(leadArgs.create.last_customer_message_at).toEqual(OLD_TS);
    const msgArgs = m.prisma.message.upsert.mock.calls[0][0];
    expect(msgArgs.create.created_at).toEqual(OLD_TS);
    expect(m.conversations.resolveForInbound).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: OLD_TS }),
    );
  });

  it('backfill NÃO incrementa não-lidas e avança ultima_interacao só com guarda lt (nunca retrocede)', async () => {
    const m = makeService();
    setupHappyPath(m);

    await m.service.saveIncomingMessage(baseInput({ backfill: { timestamp: OLD_TS } }));

    const leadArgs = m.prisma.lead.upsert.mock.calls[0][0];
    expect(leadArgs.update.mensagens_nao_lidas).toBeUndefined();
    expect(leadArgs.update.ultima_interacao).toBeUndefined();
    expect(m.prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'lead-1', ultima_interacao: { lt: OLD_TS } }),
        data: expect.objectContaining({ ultima_interacao: OLD_TS }),
      }),
    );
  });

  it('backfill não notifica: sem push, sem notificação in-app, sem webhook de saída, sem blockAi', async () => {
    const m = makeService();
    setupHappyPath(m);

    await m.service.saveIncomingMessage(baseInput({ backfill: { timestamp: OLD_TS } }));
    await m.service.saveIncomingMessage(
      baseInput({ isFromMe: true, messageId: 'wa-msg-2', backfill: { timestamp: OLD_TS } }),
    );

    expect(m.push.sendToUsers).not.toHaveBeenCalled();
    expect(m.prisma.notification.create).not.toHaveBeenCalled();
    expect(m.outboundWebhooks.dispatchMessageCreated).not.toHaveBeenCalled();
    expect(m.conversations.blockAi).not.toHaveBeenCalled();
    expect(m.conversations.syncLeadFromActive).not.toHaveBeenCalled();
  });

  it('backfill ANTIGO (>1h) não emite message:new; backfill RECENTE emite (recupera queda ao vivo)', async () => {
    const m = makeService();
    setupHappyPath(m);

    await m.service.saveIncomingMessage(baseInput({ backfill: { timestamp: OLD_TS } }));
    expect(m.gateway.emitNewMessage).not.toHaveBeenCalled();

    const recentTs = new Date(Date.now() - 5 * 60_000);
    await m.service.saveIncomingMessage(
      baseInput({ messageId: 'wa-msg-3', backfill: { timestamp: recentTs } }),
    );
    expect(m.gateway.emitNewMessage).toHaveBeenCalledTimes(1);
  });

  it('backfill ainda registra resposta do cliente no follow-up (resposta perdida deve sair da fila)', async () => {
    const m = makeService();
    setupHappyPath(m);

    await m.service.saveIncomingMessage(baseInput({ backfill: { timestamp: OLD_TS } }));

    expect(m.broadcastReply.registerCustomerReply).toHaveBeenCalledWith('lead-1', 't1');
  });

  it('regressão: SEM backfill o comportamento atual segue intacto (increment, emit, push)', async () => {
    const m = makeService();
    setupHappyPath(m);

    await m.service.saveIncomingMessage(baseInput());

    const leadArgs = m.prisma.lead.upsert.mock.calls[0][0];
    expect(leadArgs.update.mensagens_nao_lidas).toEqual({ increment: 1 });
    expect(m.gateway.emitNewMessage).toHaveBeenCalled();
    expect(m.push.sendToUsers).toHaveBeenCalled();
    expect(m.prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});

describe('InboundMessageService.saveIncomingMessage — anúncio de origem em tempo real', () => {
  /** Formato Evolution — é este objeto que o serviço grava em metadata.raw. */
  const AD_RAW = {
    data: {
      key: { id: 'wa-ad-1' },
      contextInfo: {
        externalAdReply: {
          title: 'Viva uma formatura inesquecível! ✨',
          sourceApp: 'instagram',
          sourceId: '120251874055560237',
        },
      },
    },
  };

  it('DISCRIMINANTE: message:new carrega ad_referral quando a mensagem veio de anúncio', async () => {
    const { service, prisma, gateway, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-ad',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
      metadata: { raw: AD_RAW },
    });

    await service.saveIncomingMessage(baseInput({ rawPayload: AD_RAW }));

    const [leadId, payload] = gateway.emitNewMessage.mock.calls.at(-1);
    expect(leadId).toBe('lead-1');
    expect(payload.id).toBe('msg-ad');
    expect(payload.ad_referral).toMatchObject({
      title: 'Viva uma formatura inesquecível! ✨',
      source_app: 'instagram',
      source_id: '120251874055560237',
    });
    expect(payload).not.toHaveProperty('metadata');
  });

  it('mensagem comum emite ad_referral null', async () => {
    const { service, prisma, gateway, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
      metadata: { raw: { data: { conversation: 'oi, voltei' } } },
    });

    await service.saveIncomingMessage(baseInput());

    const [, payload] = gateway.emitNewMessage.mock.calls.at(-1);
    expect(payload.ad_referral).toBeNull();
  });

  it('DISCRIMINANTE: lead novo do WhatsApp nasce no topo da coluna', async () => {
    // A maioria dos leads entra por aqui, não pelo create() da UI. Sem
    // `position`, eles caíam no default 0 do schema e o "lead novo no topo"
    // valia só para os criados na tela. Negativo = acima de todos, e o
    // relógio garante o mais recente por cima sem consultar a coluna.
    const { service, prisma, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    const antes = -Date.now();
    await service.saveIncomingMessage(baseInput());
    const depois = -Date.now();

    const [{ create }] = prisma.lead.upsert.mock.calls.at(-1);
    expect(create.position).toBeLessThanOrEqual(antes);
    expect(create.position).toBeGreaterThanOrEqual(depois);
    expect(create.position).toBeLessThan(0);
  });
});
