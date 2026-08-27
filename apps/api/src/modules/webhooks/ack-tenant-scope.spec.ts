import { EvolutionEventsHandler } from './evolution-events.handler';
import { UazapiEventsHandler } from './uazapi-events.handler';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Ack de status é escopado pelo TENANT da instância que mandou o webhook.
 *
 * O whatsapp_message_id nunca foi único global — a UNIQUE sempre começou em
 * tenant_id —, mas os dois handlers de ack consultavam `{ whatsapp_message_id }`
 * puro. Enquanto o wamid era único POR tenant isso passava despercebido; com o
 * dedupe por conversa ele virou explicitamente não-único (uma cópia por chat),
 * e uma colisão de wamid entre tenants aplicaria o ack de um no outro —
 * mensagem de outra empresa mudando de status sozinha.
 *
 * O tenant sai da instância: nome (Evolution) ou token (UazAPI), os mesmos
 * finders usados no inbound — então tenant suspenso/instância desconhecida
 * também param aqui, como já param na mensagem que chega.
 */

/** findMany que filtra por tenant_id como o Postgres filtraria. */
function fakeFindMany(rows: any[]) {
  return (args: any) => {
    const tenant = args?.where?.tenant_id ?? null;
    return Promise.resolve(rows.filter((r) => tenant === null || r.tenant_id === tenant));
  };
}

const WAMID = 'WA-COLIDIDA';
const READ_TS = new Date('2026-08-27T10:00:00.000Z');

/** A MESMA wamid em dois tenants diferentes (colisão entre empresas). */
const linhasDeDoisTenants = [
  {
    id: 'msg-do-t1',
    lead_id: 'lead-t1',
    tenant_id: 't1',
    direction: 'OUTGOING',
    created_at: READ_TS,
  },
  {
    id: 'msg-do-t2',
    lead_id: 'lead-t2',
    tenant_id: 't2',
    direction: 'OUTGOING',
    created_at: READ_TS,
  },
];

function makeEvolution(instance: unknown) {
  const prisma: any = {
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    whatsappInstance: { update: jest.fn() },
  };
  const leadsService: any = { invalidateLeadsCache: jest.fn() };
  const gateway: any = {
    emitMessageStatusUpdate: jest.fn(),
    emitLeadUnreadReset: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitInstanceStatusChanged: jest.fn(),
  };
  const inbound: any = { findEvolutionInstanceByName: jest.fn().mockResolvedValue(instance) };
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
  jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
  return { handler, prisma, gateway, inbound };
}

function makeUazapi(instance: unknown) {
  const prisma: any = {
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    lead: { findFirst: jest.fn(), update: jest.fn() },
    whatsappInstance: { update: jest.fn() },
  };
  const gateway: any = {
    emitMessageStatusUpdate: jest.fn(),
    emitInstanceStatusChanged: jest.fn(),
    emitLeadUnreadReset: jest.fn(),
  };
  const inbound: any = { findInstanceByUazapiToken: jest.fn().mockResolvedValue(instance) };
  const historySync: any = { syncUazapiInstance: jest.fn().mockResolvedValue({}) };
  const instanceHealth: any = { resolverAlerta: jest.fn().mockResolvedValue(undefined) };
  const handler = new UazapiEventsHandler(prisma, gateway, inbound, historySync, instanceHealth);
  jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
  return { handler, prisma, gateway, inbound };
}

const instanciaT1 = { id: 'i1', nome: 'porto-sul', tenant_id: 't1', status: 'open' };

describe('Evolution messages.update — ack escopado por tenant', () => {
  it('wamid existente em 2 tenants: só as mensagens do tenant da instância mudam de status', async () => {
    const { handler, prisma, gateway } = makeEvolution(instanciaT1);
    prisma.message.findMany.mockImplementation(fakeFindMany(linhasDeDoisTenants));

    await handler.handleMessageUpdate({
      instance: 'porto-sul',
      data: { keyId: WAMID, status: 'DELIVERY_ACK' },
    });

    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', whatsapp_message_id: WAMID },
      data: { status: 'DELIVERED' },
    });
    expect(gateway.emitMessageStatusUpdate).toHaveBeenCalledWith(
      'lead-t1',
      'msg-do-t1',
      'DELIVERED',
    );
    expect(gateway.emitMessageStatusUpdate).not.toHaveBeenCalledWith(
      'lead-t2',
      'msg-do-t2',
      expect.anything(),
    );
  });

  it('a busca das cópias afetadas também filtra por tenant', async () => {
    const { handler, prisma } = makeEvolution(instanciaT1);
    prisma.message.findMany.mockImplementation(fakeFindMany(linhasDeDoisTenants));

    await handler.handleMessageUpdate({
      instance: 'porto-sul',
      data: { keyId: WAMID, status: 'DELIVERY_ACK' },
    });

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenant_id: 't1', whatsapp_message_id: WAMID },
      }),
    );
  });

  it('instância desconhecida (ou tenant suspenso): descarta sem tocar em mensagem nenhuma', async () => {
    // Sem instância não há tenant — atualizar "todas as cópias do wamid" seria
    // exatamente o vazamento que este escopo existe para impedir.
    const { handler, prisma } = makeEvolution(null);
    prisma.message.findMany.mockImplementation(fakeFindMany(linhasDeDoisTenants));

    await handler.handleMessageUpdate({
      instance: 'nao-existe',
      data: { keyId: WAMID, status: 'DELIVERY_ACK' },
    });

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });
});

describe('UazAPI messages_update — ack escopado por tenant', () => {
  it('wamid existente em 2 tenants: só as mensagens do tenant do token mudam de status', async () => {
    const { handler, prisma, gateway } = makeUazapi(instanciaT1);
    prisma.message.findMany.mockImplementation(fakeFindMany(linhasDeDoisTenants));

    await handler.handleUazapiMessageAck({
      token: 'tok-1',
      message: { messageid: WAMID, status: 'DELIVERY_ACK' },
    });

    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: 't1', whatsapp_message_id: WAMID },
      data: { status: 'DELIVERED' },
    });
    expect(gateway.emitMessageStatusUpdate).toHaveBeenCalledWith(
      'lead-t1',
      'msg-do-t1',
      'DELIVERED',
    );
    expect(gateway.emitMessageStatusUpdate).not.toHaveBeenCalledWith(
      'lead-t2',
      'msg-do-t2',
      expect.anything(),
    );
  });

  it('token desconhecido: descarta sem tocar em mensagem nenhuma', async () => {
    const { handler, prisma } = makeUazapi(null);
    prisma.message.findMany.mockImplementation(fakeFindMany(linhasDeDoisTenants));

    await handler.handleUazapiMessageAck({
      token: 'tok-fantasma',
      message: { messageid: WAMID, status: 'DELIVERY_ACK' },
    });

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });
});
