import { ConversationService } from './conversation.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `inbound-message.service.spec.ts` mocka `ConversationService` por inteiro,
 * então o predicado condicional de `resolveForInbound` (I3) e o valor de
 * retorno transacional de `syncLeadFromActive` (I2) não tinham cobertura
 * nenhuma. Este spec cobre os dois direto, com Prisma mockado (sem banco).
 */

function makeMocks() {
  const prisma: any = {
    conversation: {
      upsert: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(),
    },
    lead: {
      update: jest.fn(),
    },
    $transaction: jest.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => unknown)(prisma);
    }),
  };
  return { prisma };
}

function makeService() {
  const { prisma } = makeMocks();
  const service = new ConversationService(prisma);
  return { service, prisma };
}

describe('ConversationService.resolveForInbound', () => {
  it('isFromMe=true NÃO dispara o avanço de last_customer_message_at', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-1', responsavel_id: 'B' });

    await service.resolveForInbound({
      tenantId: 't1',
      leadId: 'lead-1',
      instanceName: 'inst-b',
      defaultResponsavelId: 'B',
      isFromMe: true,
      occurredAt: new Date('2026-08-03T10:00:00Z'),
    });

    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('isFromMe=false dispara updateMany condicional (null OU lt: occurredAt)', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-1', responsavel_id: 'B' });
    const occurredAt = new Date('2026-08-03T10:00:00Z');

    await service.resolveForInbound({
      tenantId: 't1',
      leadId: 'lead-1',
      instanceName: 'inst-b',
      defaultResponsavelId: 'B',
      isFromMe: false,
      occurredAt,
    });

    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'conv-1',
        OR: [
          { last_customer_message_at: null },
          { last_customer_message_at: { lt: occurredAt } },
        ],
      },
      data: { last_customer_message_at: occurredAt },
    });
  });

  it('o upsert em si não escreve last_customer_message_at incondicionalmente no update branch', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-1', responsavel_id: 'B' });

    await service.resolveForInbound({
      tenantId: 't1',
      leadId: 'lead-1',
      instanceName: 'inst-b',
      defaultResponsavelId: 'B',
      isFromMe: false,
      occurredAt: new Date('2026-08-03T10:00:00Z'),
    });

    const upsertArgs = prisma.conversation.upsert.mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty('last_customer_message_at');
  });
});

describe('ConversationService.syncLeadFromActive', () => {
  it('aplica e retorna o patch da conversa ativa quando há conversas', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 'conv-old',
        instancia_whatsapp: 'inst-a',
        responsavel_id: 'A',
        last_customer_message_at: new Date('2026-03-10T12:00:00Z'),
      },
      {
        id: 'conv-new',
        instancia_whatsapp: 'inst-b',
        responsavel_id: 'B',
        last_customer_message_at: new Date('2026-08-03T09:00:00Z'),
      },
    ]);

    const patch = await service.syncLeadFromActive('lead-1');

    expect(patch).toEqual({ responsavel_id: 'B', instancia_whatsapp: 'inst-b' });
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { responsavel_id: 'B', instancia_whatsapp: 'inst-b' },
    });
  });

  it('retorna null e não toca no lead quando não há conversas', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.findMany.mockResolvedValue([]);

    const patch = await service.syncLeadFromActive('lead-1');

    expect(patch).toBeNull();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('engole erro da transação e retorna null (não derruba a ingestão)', async () => {
    const { service, prisma } = makeService();
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));

    const patch = await service.syncLeadFromActive('lead-1');

    expect(patch).toBeNull();
  });
});
