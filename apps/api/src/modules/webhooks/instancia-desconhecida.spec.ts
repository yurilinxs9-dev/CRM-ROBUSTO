import { EvolutionEventsHandler } from './evolution-events.handler';
import { UazapiEventsHandler } from './uazapi-events.handler';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Webhook de instância que o CRM não conhece (alguém conectou direto no
 * gateway, tenant deletado/suspenso) NÃO é erro: era um `throw` que fazia a
 * BullMQ tentar 3x — retry que nunca pode dar certo, porque a instância não
 * aparece por insistir — e cuspia stack de `error` a CADA mensagem, inundando
 * o log pra sempre.
 *
 * Comportamento esperado: descarta a mensagem, loga UM `warn` por instância a
 * cada ~10min (Map em memória, mesmo padrão do rate-limit de refresh do
 * lead-insights) e o job COMPLETA. Instância conhecida segue intocada.
 */

const JANELA_MS = 10 * 60 * 1000;

function makeEvolution(instance: unknown) {
  const prisma: any = {
    message: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    lead: { updateMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    whatsappInstance: { update: jest.fn() },
  };
  const leadsService: any = { invalidateLeadsCache: jest.fn() };
  const gateway: any = {
    emitMessageStatusUpdate: jest.fn(),
    emitLeadUnreadReset: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitInstanceStatusChanged: jest.fn(),
  };
  const inbound: any = {
    findEvolutionInstanceByName: jest.fn().mockResolvedValue(instance),
    saveIncomingMessage: jest.fn().mockResolvedValue(undefined),
  };
  const historySync: any = { syncEvolutionInstance: jest.fn().mockResolvedValue({}) };
  const instanceHealth: any = { resolverAlerta: jest.fn().mockResolvedValue(undefined) };
  const handler = new EvolutionEventsHandler(
    prisma,
    leadsService,
    gateway,
    inbound,
    historySync,
    instanceHealth,
  );
  const warn = jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn((handler as any).logger, 'error').mockImplementation(() => undefined);
  return { handler, prisma, inbound, warn, error };
}

function makeUazapi(instance: unknown) {
  const prisma: any = {
    message: { findMany: jest.fn(), updateMany: jest.fn() },
    lead: { findFirst: jest.fn(), update: jest.fn() },
    whatsappInstance: { update: jest.fn() },
  };
  const gateway: any = { emitInstanceStatusChanged: jest.fn(), emitLeadUnreadReset: jest.fn() };
  const inbound: any = {
    findInstanceByName: jest.fn().mockResolvedValue(instance),
    findInstanceByUazapiToken: jest.fn().mockResolvedValue(instance),
    saveIncomingMessage: jest.fn().mockResolvedValue(undefined),
  };
  const historySync: any = { syncUazapiInstance: jest.fn().mockResolvedValue({}) };
  const instanceHealth: any = { resolverAlerta: jest.fn().mockResolvedValue(undefined) };
  const handler = new UazapiEventsHandler(prisma, gateway, inbound, historySync, instanceHealth);
  const warn = jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
  return { handler, inbound, warn };
}

const evolutionMsg = (instance: string) => ({
  instance,
  data: {
    key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'WA-1', fromMe: false },
    message: { conversation: 'oi' },
    pushName: 'Fulano',
  },
});

const instanceRow = { id: 'i1', tenant_id: 't1', nome: 'porto-sul', status: 'open' };

describe('Evolution messages.upsert — instância não mapeada no CRM', () => {
  it('descarta sem lançar (job completa, sem retry) e não persiste nada', async () => {
    const { handler, inbound } = makeEvolution(null);
    await expect(handler.handleMessageUpsert(evolutionMsg('orfa'))).resolves.toBeUndefined();
    expect(inbound.saveIncomingMessage).not.toHaveBeenCalled();
  });

  it('loga UM warn com a instância e o motivo', async () => {
    const { handler, warn } = makeEvolution(null);
    await handler.handleMessageUpsert(evolutionMsg('orfa'));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('mensagem descartada');
    expect(msg).toContain('orfa');
    expect(msg).toContain('nao mapeada no CRM');
  });

  it('segunda mensagem da mesma instância dentro da janela não loga nada', async () => {
    const { handler, warn } = makeEvolution(null);
    await handler.handleMessageUpsert(evolutionMsg('orfa'));
    warn.mockClear();
    await handler.handleMessageUpsert(evolutionMsg('orfa'));
    await handler.handleMessageUpsert(evolutionMsg('orfa'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('depois da janela de ~10min volta a avisar (uma vez)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    try {
      const { handler, warn } = makeEvolution(null);
      await handler.handleMessageUpsert(evolutionMsg('orfa'));
      warn.mockClear();
      jest.setSystemTime(new Date(Date.now() + JANELA_MS + 1000));
      await handler.handleMessageUpsert(evolutionMsg('orfa'));
      await handler.handleMessageUpsert(evolutionMsg('orfa'));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('outra instância desconhecida tem o próprio aviso (throttle é por instância)', async () => {
    const { handler, warn } = makeEvolution(null);
    await handler.handleMessageUpsert(evolutionMsg('orfa-1'));
    await handler.handleMessageUpsert(evolutionMsg('orfa-2'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('instância conhecida segue salvando normalmente, sem warn', async () => {
    const { handler, inbound, warn } = makeEvolution(instanceRow);
    await handler.handleMessageUpsert(evolutionMsg('porto-sul'));
    expect(inbound.saveIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', phone: '5511999998888' }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Evolution contacts.upsert — instância não mapeada', () => {
  it('ignora e usa o mesmo throttle (não repete o aviso na janela)', async () => {
    const { handler, warn } = makeEvolution(null);
    const payload = { instance: 'orfa', data: [{ id: '5511999998888@s.whatsapp.net', pushName: 'X' }] };
    await expect(handler.handleContactsUpsert(payload)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    await handler.handleContactsUpsert(payload);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('throttle do aviso é por EVENTO + instância', () => {
  // Os acks entraram na regra da instância desconhecida (ver
  // ack-tenant-scope.spec.ts). Com a chave do throttle só na instância, o
  // primeiro warn de `messages.upsert` calaria o de `messages.update` da mesma
  // instância por 10min — e some justamente o sinal de "os acks pararam".
  it('Evolution: o aviso de messages.upsert não engole o de messages.update', async () => {
    const { handler, warn } = makeEvolution(null);

    await handler.handleMessageUpsert(evolutionMsg('orfa'));
    expect(warn).toHaveBeenCalledTimes(1);

    await handler.handleMessageUpdate({
      instance: 'orfa',
      data: { keyId: 'WA-1', status: 'DELIVERY_ACK' },
    });
    expect(warn).toHaveBeenCalledTimes(2);

    // ...e cada evento segue throttled dentro da própria janela.
    await handler.handleMessageUpdate({
      instance: 'orfa',
      data: { keyId: 'WA-2', status: 'READ' },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('UazAPI: o aviso de uazapi.messages não engole o do ack do mesmo token', async () => {
    const { handler, warn } = makeUazapi(null);
    const token = 'tok-super-secreto-1234';

    await handler.handleUazapiMessage({
      token,
      message: { chatid: '5511999998888@s.whatsapp.net', messageid: 'WA-1', text: 'oi' },
    });
    expect(warn).toHaveBeenCalledTimes(1);

    await handler.handleUazapiMessageAck({
      token,
      message: { messageid: 'WA-1', status: 'DELIVERY_ACK' },
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).not.toContain(token);

    await handler.handleUazapiMessageAck({
      token,
      message: { messageid: 'WA-2', status: 'READ' },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('UazAPI/WPP — mesma condição, mesmo tratamento', () => {
  it('WPP onmessage de instância desconhecida descarta com warn throttled', async () => {
    const { handler, inbound, warn } = makeUazapi(null);
    const payload = { instance: 'orfa', data: { from: '5511999998888@c.us', id: 'WA-1' } };
    await expect(handler.handleWppMessage(payload)).resolves.toBeUndefined();
    expect(inbound.saveIncomingMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    await handler.handleWppMessage(payload);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('token UazAPI desconhecido descarta com warn throttled e sem vazar o token', async () => {
    const { handler, inbound, warn } = makeUazapi(null);
    const payload = {
      token: 'tok-super-secreto-1234',
      message: { chatid: '5511999998888@s.whatsapp.net', messageid: 'WA-1', text: 'oi' },
    };
    await expect(handler.handleUazapiMessage(payload)).resolves.toBeUndefined();
    expect(inbound.saveIncomingMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('tok-super-secreto-1234');
    await handler.handleUazapiMessage(payload);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
