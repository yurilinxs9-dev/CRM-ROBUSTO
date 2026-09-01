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
 *
 * Fix round 2 (N2 do re-review): `$transaction` mockado como `(arg) =>
 * arg(prisma)` faz `tx` e `prisma` serem o MESMO objeto — `tx.conversation.
 * update` e `this.prisma.conversation.update` viram o mesmo jest.fn(),
 * indistinguíveis. Isso deixava a asserção de atomicidade cega a uma
 * regressão real: `transferActiveConversation(this.prisma, ...)` chamado
 * DEPOIS da transação (fora dela) passaria pelos mesmos três `toHaveBeenCalled`
 * sem diferença. `txClient` agora é um mock separado de `prisma` — os testes
 * afirmam que a escrita aconteceu em `txClient` e que o `prisma` "de fora"
 * NUNCA foi tocado para lead/conversation, o que só é verdade se as duas
 * escritas realmente correrem dentro do callback do `$transaction`.
 */

function makeMocks() {
  // Cliente de transação — é isto que `tx` recebe dentro do callback do
  // `$transaction`. Objeto DELIBERADAMENTE separado de `prisma` (ver nota
  // acima do fix round 2): se alguma escrita vazar pra fora da transação,
  // ela aparece no mock errado e os testes que checam "não tocou no prisma
  // de fora" pegam a regressão.
  const txClient: any = {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-1', nome: 'Cliente', ...data }),
      ),
    },
    conversation: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    // A auditoria do reassign nasce DENTRO da transação (Task D2) — ver
    // `leads-reassign-auditoria.spec.ts`, que é quem afirma o conteúdo dela.
    leadActivity: { create: jest.fn() },
  };
  const prisma: any = {
    lead: {
      // Nunca deveriam ser chamados por dentro da transação — claim/reassign
      // só usam estes fora dela (ex.: instancia_whatsapp em claim).
      updateMany: jest.fn(),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-1', nome: 'Cliente', ...data }),
      ),
      findFirst: jest.fn(),
    },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    // claim lê o modo do tenant pra decidir se o operador só pode pegar da
    // nuvem (individual) ou qualquer sem-dono (compartilhado). Esta suíte é
    // sobre a transação, não sobre o modo: compartilhado em todos os casos.
    tenant: { findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }) },
    conversation: {
      findMany: jest.fn(),
      // Idem: se isto for chamado, a escrita da conversa vazou pra fora da
      // transação.
      update: jest.fn(),
    },
    user: { findFirst: jest.fn() },
    sector: { findFirst: jest.fn() },
    leadActivity: { create: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => unknown)(txClient);
    }),
  };
  const cache: any = { delPattern: jest.fn() };
  const gateway: any = { emitLeadUpdated: jest.fn() };
  const push: any = { sendToUsers: jest.fn() };
  const assignment: any = { assignBySector: jest.fn() };
  // Kanban individual DESLIGADO (o service real devolve o próprio id nesse
  // caso): esta suíte é sobre a transação de troca de dono, não sobre coluna.
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(false),
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
  };
  return { prisma, txClient, cache, gateway, push, assignment, kanbanIndividual };
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
    m.assignment,
    {} as any, // CustomFieldsService
    {} as any, // autoActionsQueue (BullMQ)
    m.kanbanIndividual,
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
    const { service, txClient, prisma } = makeService();
    // Alex já tem uma instância própria com conversa antiga — a armadilha é
    // "consertar" isso escrevendo nela em vez de na conversa ativa.
    prisma.whatsappInstance.findFirst.mockResolvedValue({ id: 'wa-1', nome: 'inst-alex' });
    txClient.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z'), // ativa
      conv('c2', 'inst-alex', 'u-alex', '2026-03-01T10:00:00Z'), // instância do destinatário, NÃO ativa
    ]);

    await service.claim('lead-1', alex);

    expect(txClient.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: 'u-alex', assumed_at: expect.any(Date) },
    });
    expect(txClient.conversation.update).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('lead já atribuído (guard do updateMany) continua lançando ConflictException e não toca na conversa', async () => {
    const { service, txClient } = makeService();
    txClient.lead.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.claim('lead-1', alex)).rejects.toBeInstanceOf(ConflictException);
    expect(txClient.conversation.update).not.toHaveBeenCalled();
  });

  it('lead sem conversa nenhuma não quebra o claim (lead manual, nunca trocou mensagem)', async () => {
    const { service, txClient } = makeService();
    txClient.conversation.findMany.mockResolvedValue([]);

    const result = await service.claim('lead-1', alex);

    expect(result).toMatchObject({ id: 'lead-1', responsavel_id: 'u-alex' });
    expect(txClient.conversation.update).not.toHaveBeenCalled();
  });
});

describe('LeadsService.reassign — transfere a conversa ATIVA, não a do destinatário', () => {
  const gerente: AuthUser = { ...alex, id: 'u-gerente', role: UserRole.GERENTE as unknown as AuthUser['role'] };
  const novoResponsavelId = '11111111-1111-1111-1111-111111111111';

  it('cliente falou por último com a vendedora: reassign() move c1, não a conversa já do novo responsável', async () => {
    const { service, txClient, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-gerente',
      instancia_whatsapp: 'inst-vendedora',
    });
    prisma.user.findFirst.mockResolvedValue({ id: novoResponsavelId, role: 'OPERADOR' });
    prisma.whatsappInstance.findFirst.mockResolvedValue({ id: 'wa-2', nome: 'inst-novo' });
    txClient.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z'), // ativa
      conv('c2', 'inst-novo', novoResponsavelId, '2026-03-01T10:00:00Z'), // instância do novo responsável, NÃO ativa
    ]);

    await service.reassign('lead-1', { novoResponsavelId }, gerente);

    expect(txClient.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: novoResponsavelId, assumed_at: expect.any(Date) },
    });
    expect(txClient.conversation.update).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});

/**
 * Bug de producao (Diplapel, ago/2026): a IA distribuia por setor, a API
 * respondia `status: "assigned"` com o responsavel_id certo, e minutos depois
 * o lead estava de volta com o dono anterior — "muitos contatos nao foram
 * transferidos".
 *
 * Causa: `moveToSector` (e `returnToPool`) gravavam SO no Lead. A Conversation
 * seguia apontando pro dono antigo, e o `syncLeadFromActive` do inbound espelha
 * o Lead a partir da conversa ativa — ou seja, a proxima mensagem do CLIENTE
 * desfazia a distribuicao sozinha. Por isso so aparecia em lead que respondia:
 * quem nao respondia continuava transferido, o que fazia o sintoma parecer
 * aleatorio.
 */
describe('LeadsService.moveToSector — distribuicao por setor nao pode ser desfeita pelo inbound', () => {
  const gerente: AuthUser = {
    ...alex,
    id: 'u-gerente',
    role: UserRole.GERENTE as unknown as AuthUser['role'],
  };
  const sectorId = '0b202b1c-7b47-43d3-b29d-eb1a93cb2d21';
  const agenteDoSetor = 'ffdbcfb9-ebbb-49e9-8a9b-114bc96f352d';

  function cenario() {
    const s = makeService();
    s.prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      nome: 'Roberto',
      responsavel_id: 'u-diplapel',
    });
    s.prisma.sector.findFirst.mockResolvedValue({ id: sectorId, name: 'Vendas Varejo' });
    return s;
  }

  it('transfere a conversa ativa junto com o lead, no MESMO tx', async () => {
    const { service, txClient, prisma, assignment } = cenario();
    assignment.assignBySector.mockResolvedValue({ userId: agenteDoSetor, reason: 'round-robin' });
    txClient.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-diplapel', 'u-diplapel', '2026-08-12T14:46:00Z'), // ativa
      conv('c2', 'inst-varejo', agenteDoSetor, '2026-03-01T10:00:00Z'),
    ]);

    await service.moveToSector('lead-1', { sectorId }, gerente);

    // Sem esta escrita, a msg das 14:46 devolvia o lead pro dono anterior.
    expect(txClient.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: agenteDoSetor, assumed_at: expect.any(Date) },
    });
    expect(txClient.lead.update).toHaveBeenCalledTimes(1);
    // Nada pode vazar pra fora da transacao: um crash entre as duas escritas
    // reabre a mesma divergencia, so que por uma janela mais estreita.
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('setor sem agente ativo devolve a conversa ao pool tambem, nao so o lead', async () => {
    const { service, txClient, prisma, assignment } = cenario();
    assignment.assignBySector.mockResolvedValue({ userId: null, reason: 'no-active-agents' });
    txClient.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-diplapel', 'u-diplapel', '2026-08-12T14:46:00Z'),
    ]);

    await service.moveToSector('lead-1', { sectorId }, gerente);

    // assumed_at tem que zerar junto: conversa "em espera" com dono null e
    // assumed_at antigo faria o novo dono herdar o corte de historico errado.
    expect(txClient.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: null, assumed_at: null },
    });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('lead sem conversa nenhuma nao quebra a distribuicao', async () => {
    const { service, txClient, assignment } = cenario();
    assignment.assignBySector.mockResolvedValue({ userId: agenteDoSetor, reason: 'round-robin' });
    txClient.conversation.findMany.mockResolvedValue([]);

    const result = await service.moveToSector('lead-1', { sectorId }, gerente);

    expect(result).toMatchObject({ id: 'lead-1', responsavel_id: agenteDoSetor });
    expect(txClient.conversation.update).not.toHaveBeenCalled();
  });
});

describe('LeadsService.returnToPool — devolve a conversa junto', () => {
  it('zera o dono da conversa ativa no MESMO tx', async () => {
    const { service, txClient, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-alex',
      instancia_whatsapp: 'inst-alex',
    });
    txClient.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-alex', 'u-alex', '2026-08-12T14:46:00Z'),
    ]);

    await service.returnToPool('lead-1', alex);

    expect(txClient.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { responsavel_id: null, assumed_at: null },
    });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});

describe('LeadsService.claim/reassign — lead e conversa escrevem na MESMA transação', () => {
  it('claim: o Lead e a Conversation são escritos no MESMO tx, nunca no prisma de fora', async () => {
    const { service, txClient, prisma } = makeService();
    txClient.conversation.findMany.mockResolvedValue([
      conv('c1', 'inst-vendedora', 'u-vendedora', '2026-08-03T10:00:00Z'),
    ]);

    await service.claim('lead-1', alex);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // As duas escritas caíram no cliente da TRANSAÇÃO...
    expect(txClient.lead.updateMany).toHaveBeenCalledTimes(1);
    expect(txClient.conversation.update).toHaveBeenCalledTimes(1);
    // ...e NUNCA no `prisma` de fora — é esta segunda metade que pega uma
    // regressão tipo `transferActiveConversation(this.prisma, ...)` chamado
    // depois do `$transaction` resolver (mesmo `tx.lead.updateMany` correto,
    // conversa vazando pra fora não seria detectada sem isto).
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});
