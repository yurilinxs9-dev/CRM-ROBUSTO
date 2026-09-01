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
  const leadInsights: any = {
    enfileirarSeElegivel: jest.fn().mockResolvedValue(false),
  };
  const attribution: any = {
    extractClickCode: jest.fn().mockReturnValue(null),
    consumeClick: jest.fn().mockResolvedValue(null),
    fromAdReferral: jest.fn().mockReturnValue({}),
    recordFirstTouch: jest.fn().mockResolvedValue(undefined),
  };
  // Kanban individual DESLIGADO: `stageForOwner` devolve o próprio id, que é o
  // comportamento real do service quando o tenant não ligou a feature.
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(false),
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
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
    leadInsights,
    attribution,
    kanbanIndividual,
  };
}

/**
 * Banco falso de mensagens: responde `findUnique`/`findFirst` como o Postgres
 * responderia, entendendo as duas chaves compostas (a antiga
 * `tenant_id_whatsapp_message_id` e a nova `tenant_wamid_lead`) e o filtro por
 * `lead.telefone`. É o que torna honesto o teste do encaminhamento: com um
 * `mockResolvedValue` fixo, o código antigo — que perguntava só por
 * (tenant, wamid) — pareceria correto. Aqui ele acha de verdade a cópia da
 * OUTRA conversa e engole a mensagem, como acontecia em produção.
 */
type FakeRow = {
  id: string;
  wamid: string;
  lead_id: string;
  telefone: string;
  whatsapp_lid?: string;
};
function fakeMessageStore(rows: FakeRow[]) {
  /** Resolve o filtro do relacionamento `lead`, inclusive na forma OR. */
  const casaLead = (leadWhere: any, r: FakeRow): boolean => {
    if (!leadWhere) return true;
    const clausulas: any[] = leadWhere.OR ?? [leadWhere];
    return clausulas.some(
      (c) =>
        (c.telefone === undefined || c.telefone === r.telefone) &&
        (c.whatsapp_lid === undefined || c.whatsapp_lid === r.whatsapp_lid),
    );
  };
  return (args: any) => {
    const w = args?.where ?? {};
    const key = w.tenant_wamid_lead ?? w.tenant_id_whatsapp_message_id ?? null;
    const wamid = key?.whatsapp_message_id ?? w.whatsapp_message_id ?? null;
    const leadId = key?.lead_id ?? w.lead_id ?? null;
    const leadWhere = w.lead ?? null;
    // Sem nenhum critério não há o que casar (evita falso positivo).
    if (wamid === null && leadId === null && leadWhere === null) return Promise.resolve(null);
    const hit = rows.find(
      (r) =>
        (wamid === null || r.wamid === wamid) &&
        (leadId === null || r.lead_id === leadId) &&
        casaLead(leadWhere, r),
    );
    return Promise.resolve(hit ? { id: hit.id, metadata: {} } : null);
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
    m.leadInsights,
    m.attribution,
    m.kanbanIndividual,
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

describe('InboundMessageService.saveIncomingMessage — webhook duplicado não infla o badge', () => {
  it('wa_id já existente NO MESMO chat → sai ANTES do upsert do lead: sem increment, sem emit, sem push', async () => {
    const m = makeService();
    const store = fakeMessageStore([
      {
        id: 'msg-ja-salva',
        wamid: 'wa-msg-1',
        lead_id: 'lead-1',
        telefone: '5511900000000', // MESMO telefone do baseInput
      },
    ]);
    m.prisma.message.findUnique.mockImplementation(store);
    m.prisma.message.findFirst.mockImplementation(store);

    await m.service.saveIncomingMessage(baseInput());

    expect(m.prisma.lead.upsert).not.toHaveBeenCalled();
    expect(m.prisma.message.upsert).not.toHaveBeenCalled();
    expect(m.gateway.emitNewMessage).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();
  });

  it('race create→create da MENSAGEM (P2002): devolve o increment do badge', async () => {
    const m = makeService();
    m.prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    m.conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    const p2002 = Object.assign(new Error('dup'), { code: 'P2002' });
    m.prisma.message.upsert.mockRejectedValue(p2002);
    // dedupe pré-efeito não viu (race, findFirst → null por padrão), mas o
    // findUnique do catch acha a linha que o irmão acabou de gravar.
    m.prisma.message.findUnique.mockResolvedValue({ id: 'msg-do-irmao', metadata: {} });

    await m.service.saveIncomingMessage(baseInput());

    expect(m.prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', mensagens_nao_lidas: { gt: 0 } },
      data: { mensagens_nao_lidas: { decrement: 1 } },
    });
  });
});

/**
 * Task 5 — nuvem de devolvidos. Invariante: `returned_at != null` ⇔ o lead está
 * na nuvem (sem dono, esperando alguém pegar). As duas atribuições automáticas
 * do inbound dão dono ao lead, então precisam limpar o carimbo — senão um lead
 * já atendido continua listado como disponível pra todo mundo no modo foco.
 */
describe('InboundMessageService.saveIncomingMessage — atribuição automática limpa returned_at', () => {
  const leadNoPool = { ...leadOwnedByA, responsavel_id: null };

  it('auto-assign do lead em pool (dono da instância) zera returned_at', async () => {
    const { service, prisma, conversations } = makeService();
    prisma.lead.upsert.mockResolvedValue({ ...leadNoPool });
    prisma.lead.update.mockResolvedValue({ responsavel_id: 'B', instancia_whatsapp: 'inst-b' });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });

    await service.saveIncomingMessage(baseInput());

    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { responsavel_id: 'B', instancia_whatsapp: 'inst-b', returned_at: null },
    });
  });

  it('round-robin por setor zera returned_at no updateMany condicional', async () => {
    const { service, prisma, conversations, assignment } = makeService();
    // Lead segue no pool depois do upsert e a instância não tem dono → só o
    // round-robin pode atribuir.
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true, round_robin_enabled: true });
    prisma.lead.upsert.mockResolvedValue({ ...leadNoPool });
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
    assignment.resolveSectorForInstance.mockResolvedValue('sector-1');
    assignment.assignBySector.mockResolvedValue({ userId: 'C', reason: 'round-robin' });
    conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: null });
    prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: null,
    });

    await service.saveIncomingMessage(
      baseInput({ instance: { ...instanceB, owner_user_id: null } as any }),
    );

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', responsavel_id: null },
      data: { responsavel_id: 'C', instancia_whatsapp: 'inst-b', returned_at: null },
    });
  });
});

describe('InboundMessageService.saveIncomingMessage — encaminhamento p/ várias conversas', () => {
  // Bug real de produção: um vendedor encaminhou UM vídeo para 2 conversas ao
  // mesmo tempo. O WhatsApp mandou os dois webhooks com o MESMO
  // whatsapp_message_id — e a segunda cópia batia no dedupe por (tenant, wamid),
  // era tratada como duplicata e a mensagem nunca aparecia no segundo chat.
  const WAMID = 'A5C7F710366DBBEE3ED8DBD8FEC184ED';
  // Chat 1: onde a cópia JÁ existe (lead 48bb51fd, VIDEO OUTGOING).
  const OUTRO_CHAT = { id: 'lead-48bb51fd', telefone: '5511900000000' };
  // Chat 2: o que sumia (lead 4bd769d1, 553798769016).
  const ESTE_CHAT = {
    id: 'lead-4bd769d1',
    nome: 'Cliente 2',
    telefone: '553798769016',
    responsavel_id: 'B',
    instancia_whatsapp: 'jssyca',
  };

  /** Webhook do SEGUNDO chat chegando com o wamid que já existe no primeiro. */
  function segundoChat() {
    const m = makeService();
    const store = fakeMessageStore([
      {
        id: 'msg-do-chat-1',
        wamid: WAMID,
        lead_id: OUTRO_CHAT.id,
        telefone: OUTRO_CHAT.telefone,
      },
    ]);
    m.prisma.message.findUnique.mockImplementation(store);
    m.prisma.message.findFirst.mockImplementation(store);
    m.prisma.lead.upsert.mockResolvedValue({ ...ESTE_CHAT });
    m.conversations.resolveForInbound.mockResolvedValue({ id: 'conv-2', responsavel_id: 'B' });
    m.prisma.message.upsert.mockResolvedValue({
      id: 'msg-do-chat-2',
      conversation_id: 'conv-2',
      visible_to_user_id: 'B',
    });
    return m;
  }

  const inputSegundoChat = (overrides: Partial<SaveMessageInput> = {}): SaveMessageInput =>
    baseInput({
      phone: ESTE_CHAT.telefone,
      messageId: WAMID,
      instance: { id: 'inst-j', nome: 'jssyca', owner_user_id: 'B', sector_id: null } as any,
      ...overrides,
    });

  it('video encaminhado p/ 2 conversas nao some da segunda', async () => {
    const m = segundoChat();

    await m.service.saveIncomingMessage(
      inputSegundoChat({
        isFromMe: true, // encaminhado PELO vendedor
        extracted: { type: 'VIDEO', content: null } as any,
      }),
    );

    // A cópia do segundo chat precisa NASCER — pré-fix o dedupe por
    // (tenant, wamid) achava a do primeiro chat e retornava calado.
    expect(m.prisma.message.upsert).toHaveBeenCalledTimes(1);
    const [{ where, create }] = m.prisma.message.upsert.mock.calls[0];
    expect(where).toEqual({
      tenant_wamid_lead: {
        tenant_id: 't1',
        whatsapp_message_id: WAMID,
        lead_id: ESTE_CHAT.id,
      },
    });
    expect(create.lead_id).toBe(ESTE_CHAT.id);
    expect(create.type).toBe('VIDEO');
    expect(m.gateway.emitNewMessage).toHaveBeenCalled();
  });

  it('mensagem do cliente com wamid repetido em OUTRO chat também é criada (não é duplicata)', async () => {
    const m = segundoChat();

    await m.service.saveIncomingMessage(inputSegundoChat());

    expect(m.prisma.lead.upsert).toHaveBeenCalled();
    expect(m.prisma.message.upsert).toHaveBeenCalledTimes(1);
    expect(m.gateway.emitNewMessage).toHaveBeenCalled();
  });

  it('chat migrando p/ LID: mesmo wamid com telefone diferente mas MESMO lid ainda é duplicata', async () => {
    // O escopo do dedupe é o chat, e a identidade do chat muda de formato
    // quando o WhatsApp migra a conversa para @lid: o mesmo chat chega ora com
    // o telefone real, ora com os dígitos do LID. Comparando só `telefone`, a
    // re-emissão passaria como mensagem nova → badge inflando e lead fantasma.
    // Essa é a classe de bug que o unique antigo mascarava (o banco barrava),
    // e que passa a chegar no código agora que a chave inclui o lead.
    const m = makeService();
    const store = fakeMessageStore([
      {
        id: 'msg-ja-salva',
        wamid: 'wa-msg-1',
        lead_id: 'lead-1',
        telefone: '5511900000000',
        whatsapp_lid: '253227262034086@lid',
      },
    ]);
    m.prisma.message.findUnique.mockImplementation(store);
    m.prisma.message.findFirst.mockImplementation(store);

    await m.service.saveIncomingMessage(
      baseInput({
        phone: '253227262034086', // dígitos do LID, não o telefone real
        lidJid: '253227262034086@lid',
      }),
    );

    expect(m.prisma.lead.upsert).not.toHaveBeenCalled();
    expect(m.prisma.message.upsert).not.toHaveBeenCalled();
    expect(m.gateway.emitNewMessage).not.toHaveBeenCalled();
  });

  it('sem lidJid o dedupe não inventa filtro de lid (segue só pelo telefone)', async () => {
    const m = segundoChat();

    await m.service.saveIncomingMessage(inputSegundoChat());

    const [{ where }] = m.prisma.message.findFirst.mock.calls[0];
    expect(where.lead).toEqual({ telefone: ESTE_CHAT.telefone });
  });

  it('o dedupe pré-efeito consulta pelo CHAT (lead.telefone), não só por tenant+wamid', async () => {
    const m = segundoChat();

    await m.service.saveIncomingMessage(inputSegundoChat());

    expect(m.prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        tenant_id: 't1',
        whatsapp_message_id: WAMID,
        lead: { telefone: ESTE_CHAT.telefone },
      },
      select: { id: true },
    });
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

  it('race create→create no lead (P2002) re-tenta o upsert e a mensagem é salva', async () => {
    const m = makeService();
    setupHappyPath(m);
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    m.prisma.lead.upsert
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({ ...leadOwnedByA });

    await m.service.saveIncomingMessage(baseInput({ backfill: { timestamp: OLD_TS } }));

    expect(m.prisma.lead.upsert).toHaveBeenCalledTimes(2);
    expect(m.prisma.message.upsert).toHaveBeenCalledTimes(1);
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

describe('InboundMessageService.saveIncomingMessage — gatilho da ficha inteligente', () => {
  function cenario() {
    const m = makeService();
    m.prisma.lead.upsert.mockResolvedValue({ ...leadOwnedByA });
    m.conversations.resolveForInbound.mockResolvedValue({ id: 'conv-b', responsavel_id: 'B' });
    m.prisma.message.upsert.mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-b',
      visible_to_user_id: 'B',
    });
    return m;
  }

  it('mensagem do cliente enfileira a geração da ficha do lead', async () => {
    const { service, leadInsights } = cenario();

    await service.saveIncomingMessage(baseInput());

    expect(leadInsights.enfileirarSeElegivel).toHaveBeenCalledWith('lead-1', 't1');
  });

  it('mensagem NOSSA (isFromMe) não enfileira ficha — não é novidade do cliente', async () => {
    const { service, leadInsights } = cenario();

    await service.saveIncomingMessage(baseInput({ isFromMe: true }));

    expect(leadInsights.enfileirarSeElegivel).not.toHaveBeenCalled();
  });

  it('backfill de histórico não enfileira ficha — histórico não é evento novo', async () => {
    const { service, leadInsights } = cenario();

    await service.saveIncomingMessage(baseInput({ backfill: { timestamp: new Date() } }));

    expect(leadInsights.enfileirarSeElegivel).not.toHaveBeenCalled();
  });

  it('falha ao enfileirar não derruba o inbound', async () => {
    const { service, leadInsights } = cenario();
    leadInsights.enfileirarSeElegivel.mockRejectedValue(new Error('redis fora do ar'));

    // Falharia se o gatilho fosse `await` sem `.catch()`: a rejeição da fila
    // subiria e derrubaria a persistência da mensagem recebida.
    let erro: unknown = null;
    try {
      await service.saveIncomingMessage(baseInput());
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeNull();
  });
});
