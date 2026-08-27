import { EvolutionEventsHandler } from './evolution-events.handler';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Regressão do badge que "ressuscitava": ler a conversa no celular/WhatsApp
 * Web manda ack READ SÓ da última mensagem; o recálculo ingênuo contava as
 * INCOMING antigas (nunca ack-adas, != READ pra sempre) e o badge ia pra 21
 * em vez de sumir. Semântica WhatsApp: ler a msg N = leu tudo até N —
 * cascade até o created_at da lida antes de recontar.
 */

function makeHandler() {
  const prisma: any = {
    message: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    whatsappInstance: { update: jest.fn() },
  };
  const leadsService: any = { invalidateLeadsCache: jest.fn() };
  const gateway: any = {
    emitMessageStatusUpdate: jest.fn(),
    emitLeadUnreadReset: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitInstanceStatusChanged: jest.fn(),
  };
  const inbound: any = {};
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
  return { handler, prisma, gateway, leadsService, historySync, instanceHealth };
}

const READ_TS = new Date('2026-08-20T17:09:00.000Z');

describe('EvolutionEventsHandler.handleMessageUpdate — READ em INCOMING', () => {
  it('cascade: marca READ tudo até o created_at da msg lida, depois reconta e zera', async () => {
    const { handler, prisma, gateway } = makeHandler();
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'msg-lida',
        lead_id: 'lead-1',
        tenant_id: 't1',
        direction: 'INCOMING',
        created_at: READ_TS,
      },
    ]);
    prisma.message.count.mockResolvedValue(0); // depois do cascade, nada restou

    await handler.handleMessageUpdate({
      data: { keyId: 'WA-1', status: 'READ' },
    });

    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: {
        lead_id: 'lead-1',
        direction: 'INCOMING',
        status: { not: 'READ' },
        created_at: { lte: READ_TS },
      },
      data: { status: 'READ' },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', mensagens_nao_lidas: { not: 0 } },
      data: { mensagens_nao_lidas: 0 },
    });
    expect(gateway.emitLeadUnreadReset).toHaveBeenCalledWith('lead-1', 't1');
  });

  it('mensagem que chegou DEPOIS da lida continua contando no badge', async () => {
    const { handler, prisma, gateway } = makeHandler();
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'msg-lida',
        lead_id: 'lead-1',
        tenant_id: 't1',
        direction: 'INCOMING',
        created_at: READ_TS,
      },
    ]);
    prisma.message.count.mockResolvedValue(2); // 2 chegaram depois

    await handler.handleMessageUpdate({
      data: { keyId: 'WA-1', status: 'READ' },
    });

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', mensagens_nao_lidas: { not: 2 } },
      data: { mensagens_nao_lidas: 2 },
    });
    expect(gateway.emitLeadUnreadReset).not.toHaveBeenCalled();
    expect(gateway.emitLeadUpdated).toHaveBeenCalledWith(
      'lead-1',
      { mensagens_nao_lidas: 2 },
      't1',
    );
  });

  it('DELIVERY_ACK não dispara cascade nem mexe no badge', async () => {
    const { handler, prisma } = makeHandler();
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'msg-x',
        lead_id: 'lead-1',
        tenant_id: 't1',
        direction: 'INCOMING',
        created_at: READ_TS,
      },
    ]);

    await handler.handleMessageUpdate({
      data: { keyId: 'WA-1', status: 'DELIVERY_ACK' },
    });

    // updateMany do status da própria msg acontece; cascade por lead não.
    const cascade = prisma.message.updateMany.mock.calls.filter(
      (c: any[]) => c[0].where.lead_id === 'lead-1',
    );
    expect(cascade).toHaveLength(0);
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});
