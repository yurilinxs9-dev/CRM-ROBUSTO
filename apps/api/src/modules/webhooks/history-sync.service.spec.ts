import { of, throwError } from 'rxjs';
import { HistorySyncService } from './history-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * HistorySyncService — varre /chat/find e /message/find da UazAPI e re-injeta
 * mensagens perdidas na fila `webhooks` como jobs `uazapi.messages` com flag
 * backfill. Mocks na borda (HTTP, fila, Prisma), sem banco.
 */

const NOW = 1_800_000_000_000; // âncora fixa pra janelas
const HOUR = 3_600_000;

const instanceRow = {
  id: 'inst-1',
  nome: 'isamara',
  tenant_id: 't1',
  status: 'open',
  config: { uazapi_token: 'tok-1' },
};

function chatPayload(overrides: Record<string, unknown> = {}) {
  return {
    wa_chatid: '553186332984@s.whatsapp.net',
    wa_chatlid: '126740374524068@lid',
    wa_isGroup: false,
    name: 'Ricardo Borges',
    wa_contactName: 'Ricardo Borges',
    wa_lastMsgTimestamp: NOW - HOUR,
    ...overrides,
  };
}

function msgPayload(id: string, ts: number, overrides: Record<string, unknown> = {}) {
  return {
    messageid: id,
    chatid: '553186332984@s.whatsapp.net',
    fromMe: false,
    messageTimestamp: ts,
    messageType: 'Conversation',
    text: 'oi',
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    whatsappInstance: {
      findUnique: jest.fn().mockResolvedValue({ ...instanceRow }),
      findMany: jest.fn().mockResolvedValue([{ ...instanceRow }]),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const http: any = { post: jest.fn() };
  const config: any = { get: jest.fn().mockReturnValue('https://uaz.test') };
  const queue: any = { add: jest.fn().mockResolvedValue(undefined) };
  const gateway: any = { emitLeadUnreadReset: jest.fn() };
  const cache: any = { delPattern: jest.fn().mockResolvedValue(undefined) };
  const service = new HistorySyncService(prisma, http, config, queue, gateway, cache);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  return { service, prisma, http, config, queue, gateway, cache };
}

afterEach(() => jest.restoreAllMocks());

describe('HistorySyncService.syncInstance', () => {
  it('instância sem token retorna zeros sem tocar HTTP', async () => {
    const { service, prisma, http } = makeService();
    prisma.whatsappInstance.findUnique.mockResolvedValue({ ...instanceRow, config: {} });

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(r).toEqual({ chats_scanned: 0, chats_synced: 0, messages_enqueued: 0 });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('chat com gap enfileira jobs uazapi.messages com backfill e jobId determinístico', async () => {
    const { service, http, queue } = makeService();
    http.post
      .mockReturnValueOnce(of({ data: { chats: [chatPayload()] } })) // /chat/find
      .mockReturnValueOnce(
        of({
          data: {
            hasMore: false,
            messages: [msgPayload('A', NOW - HOUR), msgPayload('B', NOW - 2 * HOUR)],
          },
        }),
      );

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(r).toEqual({ chats_scanned: 1, chats_synced: 1, messages_enqueued: 2 });
    expect(queue.add).toHaveBeenCalledTimes(2);
    const [name, payload, opts] = queue.add.mock.calls[0];
    expect(name).toBe('uazapi.messages');
    expect(payload).toMatchObject({ event: 'uazapi.messages', token: 'tok-1', backfill: true });
    expect(payload.message.messageid).toBe('A');
    expect(opts.jobId).toBe('bf-inst-1-A');
  });

  it('mensagem mais nova do servidor já no banco (wa_id) → chat em dia, zero jobs (disparo com throttle)', async () => {
    const { service, prisma, http, queue } = makeService();
    prisma.message.findUnique.mockResolvedValue({ id: 'msg-existente' });
    http.post
      .mockReturnValueOnce(of({ data: { chats: [chatPayload()] } }))
      .mockReturnValueOnce(
        of({ data: { hasMore: false, messages: [msgPayload('A', NOW - HOUR)] } }),
      );

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(queue.add).not.toHaveBeenCalled();
    expect(r.messages_enqueued).toBe(0);
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenant_id_whatsapp_message_id: { tenant_id: 't1', whatsapp_message_id: 'A' },
        },
        select: { id: true },
      }),
    );
  });

  it('chat em dia (banco dentro da margem) não busca mensagens', async () => {
    const { service, prisma, http, queue } = makeService();
    prisma.message.findFirst.mockResolvedValue({ created_at: new Date(NOW - HOUR) });
    http.post.mockReturnValueOnce(of({ data: { chats: [chatPayload()] } }));

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(r.chats_synced).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(1); // só /chat/find
  });

  it('para de paginar quando a página só tem chats fora da janela', async () => {
    const { service, http } = makeService();
    const stale = chatPayload({ wa_lastMsgTimestamp: NOW - 100 * HOUR });
    http.post.mockReturnValueOnce(of({ data: { chats: [stale] } }));

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(r).toEqual({ chats_scanned: 0, chats_synced: 0, messages_enqueued: 0 });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('mensagens fora da janela não são enfileiradas e param a paginação do chat', async () => {
    const { service, http, queue } = makeService();
    http.post
      .mockReturnValueOnce(of({ data: { chats: [chatPayload()] } }))
      .mockReturnValueOnce(
        of({
          data: {
            hasMore: true,
            nextOffset: 2,
            messages: [msgPayload('A', NOW - HOUR), msgPayload('OLD', NOW - 100 * HOUR)],
          },
        }),
      );

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(r.messages_enqueued).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledTimes(2); // não pediu a página seguinte
  });

  it('nome da AGENDA (wa_contactName) sobrescreve pushName divergente; lid entra quando faltava', async () => {
    const { service, prisma, http } = makeService();
    http.post
      .mockReturnValueOnce(of({ data: { chats: [chatPayload()] } }))
      .mockReturnValueOnce(of({ data: { hasMore: false, messages: [] } }));

    await service.syncInstance('inst-1', 48 * HOUR);

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', telefone: '553186332984', nome: { not: 'Ricardo Borges' } },
      data: { nome: 'Ricardo Borges' },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', telefone: '553186332984', whatsapp_lid: null },
      data: { whatsapp_lid: '126740374524068@lid' },
    });
  });

  it('sem nome de agenda, o nome do chat só substitui placeholder (nome = telefone)', async () => {
    const { service, prisma, http } = makeService();
    http.post
      .mockReturnValueOnce(
        of({ data: { chats: [chatPayload({ wa_contactName: '', name: 'Perfil Cliente' })] } }),
      )
      .mockReturnValueOnce(of({ data: { hasMore: false, messages: [] } }));

    await service.syncInstance('inst-1', 48 * HOUR);

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', telefone: '553186332984', nome: '553186332984' },
      data: { nome: 'Perfil Cliente' },
    });
  });

  it('erro no /message/find de um chat não derruba a varredura', async () => {
    const { service, http } = makeService();
    const chatB = chatPayload({ wa_chatid: '553799999999@s.whatsapp.net', wa_chatlid: '' });
    http.post
      .mockReturnValueOnce(of({ data: { chats: [chatPayload(), chatB] } }))
      .mockReturnValueOnce(throwError(() => new Error('boom')))
      .mockReturnValueOnce(of({ data: { hasMore: false, messages: [msgPayload('C', NOW - HOUR)] } }));

    const r = await service.syncInstance('inst-1', 48 * HOUR);

    expect(r.chats_scanned).toBe(2);
    expect(r.messages_enqueued).toBe(1);
  });

  it('reentrância: segunda chamada concorrente retorna zeros', async () => {
    const { service, http } = makeService();
    let release: (v: { data: unknown }) => void = () => undefined;
    const gate = new Promise<{ data: unknown }>((res) => (release = res));
    http.post.mockReturnValueOnce(of()).mockReturnValue(of());
    // primeira chamada fica pendurada no findUnique pra simular sync em curso
    const { prisma } = { prisma: (service as any).prisma };
    const orig = prisma.whatsappInstance.findUnique;
    prisma.whatsappInstance.findUnique = jest.fn(
      () => gate.then(() => ({ ...instanceRow, config: {} })),
    );

    const p1 = service.syncInstance('inst-1', HOUR);
    const r2 = await service.syncInstance('inst-1', HOUR);
    release({ data: {} });
    await p1;
    prisma.whatsappInstance.findUnique = orig;

    expect(r2).toEqual({ chats_scanned: 0, chats_synced: 0, messages_enqueued: 0 });
  });
});

describe('HistorySyncService — badge espelha o aparelho', () => {
  it('wa_unreadCount=0 no servidor + não-lidas no CRM → zera badge, marca READ e emite reset', async () => {
    const m = makeService();
    m.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    // chat em dia (sem gap) — badge reconcilia mesmo assim
    m.prisma.message.findFirst.mockResolvedValue({ created_at: new Date(NOW - HOUR) });
    m.http.post.mockReturnValueOnce(
      of({ data: { chats: [chatPayload({ wa_unreadCount: 0 })] } }),
    );

    await m.service.syncInstance('inst-1', 48 * HOUR);

    expect(m.prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-9' },
      data: { mensagens_nao_lidas: 0 },
    });
    expect(m.prisma.message.updateMany).toHaveBeenCalledWith({
      where: { lead_id: 'lead-9', direction: 'INCOMING', status: { not: 'READ' } },
      data: { status: 'READ' },
    });
    expect(m.gateway.emitLeadUnreadReset).toHaveBeenCalledWith('lead-9', 't1');
    expect(m.cache.delPattern).toHaveBeenCalledWith('leads:list:t1:*');
  });

  it('wa_unreadCount>0 no servidor NÃO mexe no badge (leitura no CRM não chega ao celular)', async () => {
    const m = makeService();
    m.prisma.message.findFirst.mockResolvedValue({ created_at: new Date(NOW - HOUR) });
    m.http.post.mockReturnValueOnce(
      of({ data: { chats: [chatPayload({ wa_unreadCount: 4 })] } }),
    );

    await m.service.syncInstance('inst-1', 48 * HOUR);

    expect(m.prisma.lead.update).not.toHaveBeenCalled();
    expect(m.gateway.emitLeadUnreadReset).not.toHaveBeenCalled();
  });

  it('CRM já zerado → nada a fazer (sem update, sem emit)', async () => {
    const m = makeService();
    m.prisma.lead.findFirst.mockResolvedValue(null); // nenhum lead com não-lidas > 0
    m.prisma.message.findFirst.mockResolvedValue({ created_at: new Date(NOW - HOUR) });
    m.http.post.mockReturnValueOnce(
      of({ data: { chats: [chatPayload({ wa_unreadCount: 0 })] } }),
    );

    await m.service.syncInstance('inst-1', 48 * HOUR);

    expect(m.prisma.lead.update).not.toHaveBeenCalled();
    expect(m.gateway.emitLeadUnreadReset).not.toHaveBeenCalled();
  });
});

describe('HistorySyncService — badges presas de qualquer idade', () => {
  it('lead não-lido fora da janela: servidor diz unread=0 → zera; unread>0 → não mexe', async () => {
    const m = makeService();
    m.prisma.lead.findMany.mockResolvedValue([
      { id: 'lead-old', telefone: '553111111111' },
      { id: 'lead-hot', telefone: '553122222222' },
    ]);
    m.http.post
      .mockReturnValueOnce(of({ data: { chats: [] } })) // /chat/find da varredura (sem chats na janela)
      .mockReturnValueOnce(
        of({
          data: {
            chats: [
              { ...chatPayload({ wa_chatid: '553111111111@s.whatsapp.net', wa_unreadCount: 0 }) },
            ],
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            chats: [
              { ...chatPayload({ wa_chatid: '553122222222@s.whatsapp.net', wa_unreadCount: 5 }) },
            ],
          },
        }),
      );

    await m.service.syncInstance('inst-1', 48 * HOUR);

    expect(m.prisma.lead.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-old' },
      data: { mensagens_nao_lidas: 0 },
    });
    expect(m.gateway.emitLeadUnreadReset).toHaveBeenCalledWith('lead-old', 't1');
    // consulta exata por chatid do lead preso
    expect(m.http.post).toHaveBeenCalledWith(
      'https://uaz.test/chat/find',
      expect.objectContaining({ wa_chatid: '553111111111@s.whatsapp.net' }),
      expect.anything(),
    );
  });

  it('chat não encontrado no servidor = sem prova → badge fica', async () => {
    const m = makeService();
    m.prisma.lead.findMany.mockResolvedValue([{ id: 'lead-x', telefone: '553133333333' }]);
    m.http.post
      .mockReturnValueOnce(of({ data: { chats: [] } }))
      .mockReturnValueOnce(of({ data: { chats: [] } }));

    await m.service.syncInstance('inst-1', 48 * HOUR);

    expect(m.prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('HistorySyncService — instâncias Evolution (espelho completo)', () => {
  const evoInstance = { id: 'inst-evo', nome: 'teste', tenant_id: 't1', config: { provider: 'evolution' } };

  it('badges: unreadCount=0 zera (inclusive @lid via remoteJidAlt e chats FORA da janela); >0 não mexe', async () => {
    const m = makeService();
    m.prisma.whatsappInstance.findMany.mockResolvedValue([evoInstance]);
    m.prisma.whatsappInstance.findUnique.mockResolvedValue(evoInstance);
    m.prisma.lead.findMany.mockResolvedValue([
      { id: 'lead-lido', telefone: '553799086000' },
      { id: 'lead-pendente', telefone: '553798083479' },
      { id: 'lead-lid', telefone: '553791048239' },
    ]);
    const OLD = NOW - 100 * HOUR; // fora da janela de 1h — badge zera mesmo assim
    m.http.post.mockReturnValueOnce(
      of({
        data: [
          {
            remoteJid: '553799086000@s.whatsapp.net',
            unreadCount: 0,
            lastMessage: { key: { id: 'K1' }, messageTimestamp: Math.floor(OLD / 1000) },
          },
          {
            remoteJid: '553798083479@s.whatsapp.net',
            unreadCount: 5,
            lastMessage: { key: { id: 'K2' }, messageTimestamp: Math.floor(OLD / 1000) },
          },
          {
            remoteJid: '231314238263306@lid',
            unreadCount: 0,
            lastMessage: {
              key: { id: 'K3', remoteJidAlt: '553791048239@s.whatsapp.net' },
              messageTimestamp: Math.floor(OLD / 1000),
            },
          },
        ],
      }),
    );

    await m.service.syncAllUazapi(HOUR);

    expect(m.http.post).toHaveBeenCalledWith(
      'https://uaz.test/chat/findChats/teste',
      {},
      expect.objectContaining({ headers: { apikey: 'https://uaz.test' } }),
    );
    const zeroed = m.prisma.lead.update.mock.calls.map((c: any[]) => c[0].where.id).sort();
    expect(zeroed).toEqual(['lead-lid', 'lead-lido']);
  });

  it('chat com buraco na janela: pagina findMessages e re-injeta como messages.upsert com backfill', async () => {
    const m = makeService();
    m.prisma.whatsappInstance.findMany.mockResolvedValue([evoInstance]);
    m.prisma.whatsappInstance.findUnique.mockResolvedValue(evoInstance);
    const ts = Math.floor((NOW - HOUR) / 1000); // epoch s, dentro da janela
    m.http.post
      .mockReturnValueOnce(
        of({
          data: [
            {
              remoteJid: '253227262034086@lid',
              unreadCount: null,
              lastMessage: {
                key: { id: 'NEW-1', remoteJidAlt: '553799086000@s.whatsapp.net' },
                messageTimestamp: ts,
              },
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            messages: {
              records: [
                { key: { id: 'NEW-1', fromMe: false }, messageTimestamp: ts, message: { conversation: 'oi' } },
                { key: { id: 'NEW-2', fromMe: true }, messageTimestamp: ts - 60, message: { conversation: 'olá' } },
              ],
              total: 2,
              pages: 1,
              currentPage: 1,
            },
          },
        }),
      );

    const r = await m.service.syncAllUazapi(48 * HOUR);

    expect(r[0]).toEqual({ chats_scanned: 1, chats_synced: 1, messages_enqueued: 2 });
    const [name, payload, opts] = m.queue.add.mock.calls[0];
    expect(name).toBe('messages.upsert');
    expect(payload).toMatchObject({
      event: 'messages.upsert',
      instance: 'teste',
      backfill: true,
      chat_phone: '553799086000',
    });
    expect(payload.data.key.id).toBe('NEW-1');
    expect(opts.jobId).toBe('bf-inst-evo-NEW-1');
  });

  it('prova exata: newestId do findChats já no banco → nem chama findMessages', async () => {
    const m = makeService();
    m.prisma.whatsappInstance.findMany.mockResolvedValue([evoInstance]);
    m.prisma.whatsappInstance.findUnique.mockResolvedValue(evoInstance);
    m.prisma.message.findUnique.mockResolvedValue({ id: 'ja-existe' });
    m.http.post.mockReturnValueOnce(
      of({
        data: [
          {
            remoteJid: '553799086000@s.whatsapp.net',
            unreadCount: null,
            lastMessage: {
              key: { id: 'JA-SALVA' },
              messageTimestamp: Math.floor((NOW - HOUR) / 1000),
            },
          },
        ],
      }),
    );

    const r = await m.service.syncAllUazapi(48 * HOUR);

    expect(r[0].messages_enqueued).toBe(0);
    expect(m.queue.add).not.toHaveBeenCalled();
    expect(m.http.post).toHaveBeenCalledTimes(1); // só o findChats
  });
});

describe('HistorySyncService.syncAllUazapi', () => {
  it('sincroniza só instâncias open com token uazapi', async () => {
    const { service, prisma, http } = makeService();
    prisma.whatsappInstance.findMany.mockResolvedValue([
      { ...instanceRow },
      { ...instanceRow, id: 'inst-2', config: {} }, // sem token
    ]);
    prisma.whatsappInstance.findUnique
      .mockResolvedValueOnce({ ...instanceRow })
      .mockResolvedValueOnce({ ...instanceRow, id: 'inst-2', config: {} });
    http.post.mockReturnValue(of({ data: { chats: [] } }));

    const r = await service.syncAllUazapi(HOUR);

    expect(prisma.whatsappInstance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'open' }) }),
    );
    expect(r).toHaveLength(1); // a sem token nem entra
  });
});
