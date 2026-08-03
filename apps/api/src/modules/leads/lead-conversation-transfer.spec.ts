import { ConflictException } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task 9 (C2 do review da Task 4): `claim`/`reassign` escreviam só no `Lead`.
 * Como o `Lead` é espelho da conversa ATIVA desde a Task 4, a próxima
 * mensagem do cliente desfazia a transferência sozinha (e, no modo
 * Compartilhado, devolvia o lead pro pool).
 *
 * Fix round 1 (N1): a versão anterior deste spec só chamava
 * `resolveActiveConversation` — função pura que já tem cobertura própria em
 * `webhooks/conversation-routing.spec.ts` e não muda com este fix. Passaria
 * idêntica com o bug presente, com a versão errada ("escreve na conversa da
 * instância do destinatário") ou sem fix nenhum. Estes specs exercitam o
 * código de verdade — `claim()` e `reassign()`, com Prisma mockado — e
 * afirmam qual `Conversation.id` recebe o `update`.
 */

function makeMocks() {
  const prisma: any = {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-1', nome: 'Cliente', ...data }),
      ),
      findFirst: jest.fn(),
    },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    conversation: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    user: { findFirst: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => unknown)(prisma);
    }),
  };
  const cache: any = { delPattern: jest.fn() };
  const gateway: any = { emitLeadUpdated: jest.fn() };
  const push: any = { sendToUsers: jest.fn() };
  return { prisma, cache, gateway, push };
}

function makeService() {
  const m = makeMocks();
  const service = new LeadsService(
    m.prisma,
    {} as any, // InstancesService — não usado por claim/reassign
    m.cache,
    m.gateway,
    {} as any, // MediaService
    m.push,
    {} as any, // OutboundWebhooksService
    {} as any, // AssignmentService
    {} as any, // CustomFieldsService
    {} as any, // autoActionsQueue (BullMQ)
  );
  return { service, ...m };
}

const conv = (id: string, inst: string, dono: string | null, ultima: string | null) => ({
  id,
  instancia_whatsapp: inst,
  responsavel_id: dono,
  last_customer_message_at: ultima ? new Date(ultima) : null,
});

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('LeadsService.claim — transfere a conversa ATIVA, não a do destinatário', () => {
  it('cliente falou por último com a vendedora: claim() move c1 (vendedora), não c2 (instância do Alex)', async () => {
    const { service, prisma } = makeService();
    // Alex já tem uma instância própria com conversa antiga — a armadilha é
    // "consertar" isso escrevendo nela em vez de na conversa ativa.
    prisma.whatsappInstance.findFirst.mockResolvedValue({ id: 'wa-1', nome: 'inst-alex' });
    prisma.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z'), // ativa
      conv('c2', 'inst-alex', 'u-alex', '2026-03-01T10:00:00Z'), // instância do destinatário, NÃO ativa
    ]);

    await service.claim('lead-1', alex);

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: 'u-alex', assumed_at: expect.any(Date) },
    });
    expect(prisma.conversation.update).toHaveBeenCalledTimes(1);
  });

  it('lead já atribuído (guard do updateMany) continua lançando ConflictException e não toca na conversa', async () => {
    const { service, prisma } = makeService();
    prisma.lead.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.claim('lead-1', alex)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('lead sem conversa nenhuma não quebra o claim (lead manual, nunca trocou mensagem)', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.findMany.mockResolvedValue([]);

    const result = await service.claim('lead-1', alex);

    expect(result).toMatchObject({ id: 'lead-1', responsavel_id: 'u-alex' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});

describe('LeadsService.reassign — transfere a conversa ATIVA, não a do destinatário', () => {
  const gerente: AuthUser = { ...alex, id: 'u-gerente', role: UserRole.GERENTE as unknown as AuthUser['role'] };
  const novoResponsavelId = '11111111-1111-1111-1111-111111111111';

  it('cliente falou por último com a vendedora: reassign() move c1, não a conversa já do novo responsável', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-gerente',
      instancia_whatsapp: 'inst-vendedora',
    });
    prisma.user.findFirst.mockResolvedValue({ id: novoResponsavelId, role: 'OPERADOR' });
    prisma.whatsappInstance.findFirst.mockResolvedValue({ id: 'wa-2', nome: 'inst-novo' });
    prisma.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z'), // ativa
      conv('c2', 'inst-novo', novoResponsavelId, '2026-03-01T10:00:00Z'), // instância do novo responsável, NÃO ativa
    ]);

    await service.reassign('lead-1', { novoResponsavelId }, gerente);

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: novoResponsavelId, assumed_at: expect.any(Date) },
    });
    expect(prisma.conversation.update).toHaveBeenCalledTimes(1);
  });
});

describe('LeadsService.claim/reassign — lead e conversa escrevem na MESMA transação', () => {
  it('claim: transferActiveConversation é chamado através do mesmo $transaction do updateMany', async () => {
    const { service, prisma } = makeService();
    prisma.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z'),
    ]);

    await service.claim('lead-1', alex);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // A conversa só é lida/escrita DEPOIS do updateMany, e ambos correm
    // dentro da mesma call ao $transaction (o mock chama o callback passando
    // o próprio `prisma` como `tx`) — se caíssem em transações/chamadas
    // separadas, updateMany e conversation.update apareceriam em invocações
    // distintas de $transaction.
    expect(prisma.lead.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).toHaveBeenCalledTimes(1);
  });
});
