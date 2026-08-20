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
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const http: any = { post: jest.fn() };
  const config: any = { get: jest.fn().mockReturnValue('https://uaz.test') };
  const queue: any = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new HistorySyncService(prisma, http, config, queue);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  return { service, prisma, http, config, queue };
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

  it('atualiza nome placeholder e lid do lead a partir do chat', async () => {
    const { service, prisma, http } = makeService();
    http.post
      .mockReturnValueOnce(of({ data: { chats: [chatPayload()] } }))
      .mockReturnValueOnce(of({ data: { hasMore: false, messages: [] } }));

    await service.syncInstance('inst-1', 48 * HOUR);

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', telefone: '553186332984', nome: '553186332984' },
      data: { nome: 'Ricardo Borges' },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', telefone: '553186332984', whatsapp_lid: null },
      data: { whatsapp_lid: '126740374524068@lid' },
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
