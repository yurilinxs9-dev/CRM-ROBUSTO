import { ConflictException } from '@nestjs/common';
import { LeadsService, patchDaNuvem } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task 5 (modo individual redondo): a nuvem de devolvidos.
 *
 * Invariante único desta suíte:
 *
 *   `Lead.returned_at != null`  ⇔  o lead está na NUVEM (devolvido, sem dono).
 *
 * Ou seja: QUALQUER escrita que dá dono a um lead zera `returned_at`, e toda
 * devolução (manual pelo botão "Devolver ao Escritório", ou automática quando
 * o setor não tem agente ativo) carimba com a hora.
 *
 * Por que isso importa: desde a Task 2 a visibilidade do operador em modo foco
 * é `{ responsavel_id: null, returned_at: { not: null } }`. Se uma atribuição
 * esquecer de zerar o carimbo, o lead continua listado na nuvem de todo mundo
 * mesmo já tendo dono; se uma devolução esquecer de carimbar, o lead some do
 * mapa (ninguém é dono e ninguém enxerga). Os dois lados do ⇔ estão testados
 * aqui.
 *
 * Estilo dos mocks copiado de `lead-conversation-transfer.spec.ts`, que
 * exercita exatamente as mesmas funções: `txClient` é um objeto SEPARADO do
 * `prisma` justamente porque claim/reassign/moveToSector/returnToPool escrevem
 * o lead dentro do `$transaction`.
 */

function makeMocks() {
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
    leadActivity: { create: jest.fn() },
  };
  const prisma: any = {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-1', nome: 'Cliente', ...data }),
      ),
      findFirst: jest.fn(),
    },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    // Modo do tenant lido pelo claim. Default compartilhado (pool_enabled=true)
    // = comportamento antigo; a suíte do modo individual sobrescreve.
    tenant: { findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }) },
    conversation: { findMany: jest.fn(), update: jest.fn() },
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
  const outboundWebhooks: any = {
    dispatchLeadEvent: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, txClient, cache, gateway, push, assignment, outboundWebhooks };
}

function makeService() {
  const m = makeMocks();
  const service = new LeadsService(
    m.prisma,
    {} as any, // InstancesService
    m.cache,
    m.gateway,
    {} as any, // MediaService
    m.push,
    m.outboundWebhooks,
    m.assignment,
    {} as any, // CustomFieldsService
    {} as any, // autoActionsQueue (BullMQ)
  );
  return { service, ...m };
}

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};
const gerente: AuthUser = {
  ...alex,
  id: 'u-gerente',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
};

/** `data` do único `lead.update` chamado no mock. */
const dataDoUpdate = (mock: jest.Mock) => mock.mock.calls[0][0].data;
/** `where` do único `lead.updateMany` chamado no mock. */
const whereDoUpdateMany = (mock: jest.Mock) => mock.mock.calls[0][0].where;

describe('nuvem de devolvidos — devolução CARIMBA returned_at', () => {
  it('returnToPool: carimba returned_at junto de zerar dono/assumed_at/privacidade', async () => {
    const { service, txClient, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-alex',
      instancia_whatsapp: 'inst-alex',
    });

    await service.returnToPool('lead-1', alex);

    expect(txClient.lead.update).toHaveBeenCalledTimes(1);
    expect(dataDoUpdate(txClient.lead.update)).toEqual({
      responsavel_id: null,
      assumed_at: null,
      is_private: false,
      returned_at: expect.any(Date),
    });
  });

  it('moveToSector sem agente ativo: devolução AUTOMÁTICA também é nuvem', async () => {
    const { service, txClient, prisma, assignment } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      nome: 'Roberto',
      responsavel_id: 'u-diplapel',
    });
    prisma.sector.findFirst.mockResolvedValue({ id: 's-1', name: 'Vendas Varejo' });
    assignment.assignBySector.mockResolvedValue({ userId: null, reason: 'no-active-agents' });

    await service.moveToSector(
      'lead-1',
      { sectorId: '0b202b1c-7b47-43d3-b29d-eb1a93cb2d21' },
      gerente,
    );

    expect(dataDoUpdate(txClient.lead.update)).toEqual({
      responsavel_id: null,
      assumed_at: null,
      is_private: false,
      returned_at: expect.any(Date),
    });
  });
});

describe('nuvem de devolvidos — atribuição de dono ZERA returned_at', () => {
  it('claim: o updateMany do lead limpa o carimbo', async () => {
    const { service, txClient } = makeService();

    await service.claim('lead-1', alex);

    expect(txClient.lead.updateMany).toHaveBeenCalledTimes(1);
    expect(dataDoUpdate(txClient.lead.updateMany)).toEqual({
      responsavel_id: 'u-alex',
      assumed_at: expect.any(Date),
      is_private: false,
      returned_at: null,
    });
  });

  it('reassign: o update do lead limpa o carimbo', async () => {
    const { service, txClient, prisma } = makeService();
    const novoResponsavelId = '11111111-1111-1111-1111-111111111111';
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-gerente',
      instancia_whatsapp: 'inst-x',
    });
    prisma.user.findFirst.mockResolvedValue({ id: novoResponsavelId, role: 'OPERADOR' });

    await service.reassign('lead-1', { novoResponsavelId }, gerente);

    // Igualdade estrita: `whatsappInstance.findFirst` devolve null por padrão,
    // então NÃO há `instancia_whatsapp` no data — se aparecer, é regressão.
    // `is_private: false` entra junto (como em claim/moveToSector): lead que o
    // gerente privatizou ao assumir não pode seguir escondido da supervisão
    // debaixo do novo responsável.
    expect(dataDoUpdate(txClient.lead.update)).toEqual({
      responsavel_id: novoResponsavelId,
      assumed_at: expect.any(Date),
      returned_at: null,
      is_private: false,
    });
  });

  it('moveToSector com agente do round-robin: limpa o carimbo', async () => {
    const { service, txClient, prisma, assignment } = makeService();
    const agente = 'ffdbcfb9-ebbb-49e9-8a9b-114bc96f352d';
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      nome: 'Roberto',
      responsavel_id: 'u-diplapel',
    });
    prisma.sector.findFirst.mockResolvedValue({ id: 's-1', name: 'Vendas Varejo' });
    assignment.assignBySector.mockResolvedValue({ userId: agente, reason: 'round-robin' });

    await service.moveToSector(
      'lead-1',
      { sectorId: '0b202b1c-7b47-43d3-b29d-eb1a93cb2d21' },
      gerente,
    );

    // Idem: sem instância própria do agente, o data é exatamente este.
    expect(dataDoUpdate(txClient.lead.update)).toEqual({
      responsavel_id: agente,
      assumed_at: expect.any(Date),
      is_private: false,
      returned_at: null,
    });
  });

  it('bulkAssign: atribuição em massa tira todos da nuvem', async () => {
    const { service, prisma } = makeService();
    const responsavel_id = '11111111-1111-1111-1111-111111111111';

    await service.bulkAssign(
      { ids: ['22222222-2222-2222-2222-222222222222'], responsavel_id },
      gerente,
    );

    expect(dataDoUpdate(prisma.lead.updateMany)).toEqual({
      responsavel_id,
      returned_at: null,
    });
  });

  it('update (ficha do lead): trocar o responsável tira o lead da nuvem', async () => {
    const { service, txClient, prisma } = makeService();
    const responsavel_id = '11111111-1111-1111-1111-111111111111';
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: null,
      nome: 'Cliente',
      telefone: '5511900000000',
      email: null,
      temperatura: 'FRIO',
      valor_estimado: null,
      empresa: null,
      cargo: null,
      tags: [],
      dados_custom: null,
    });

    await service.update('lead-1', { responsavel_id }, gerente);

    expect(dataDoUpdate(txClient.lead.update)).toEqual({
      responsavel_id,
      returned_at: null,
    });
  });

  it('update com responsavel_id null é ignorado pelo schema (devolver é botão, não PATCH)', async () => {
    // `vazioComoAusente` transforma null em undefined: a ficha manda o campo
    // sempre, e vazio significa "não mexe no responsável". Este caso trava esse
    // contrato — se ele mudar, o ramo de devolução do `patchDaNuvem` (testado
    // logo abaixo) é que passa a valer, e nunca a limpeza silenciosa do carimbo.
    const { service, txClient, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-alex',
      nome: 'Cliente',
      telefone: '5511900000000',
      email: null,
      temperatura: 'FRIO',
      valor_estimado: null,
      empresa: null,
      cargo: null,
      tags: [],
      dados_custom: null,
    });

    await service.update('lead-1', { responsavel_id: null, tags: ['vip'] }, gerente);

    expect(dataDoUpdate(txClient.lead.update)).toEqual({ tags: ['vip'] });
  });

  it('update sem mexer no responsável NÃO toca em returned_at', async () => {
    const { service, txClient, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-alex',
      nome: 'Cliente',
      telefone: '5511900000000',
      email: null,
      temperatura: 'FRIO',
      valor_estimado: null,
      empresa: null,
      cargo: null,
      tags: [],
      dados_custom: null,
    });

    await service.update('lead-1', { nome: 'Cliente Novo' }, gerente);

    expect(dataDoUpdate(txClient.lead.update)).toEqual({ nome: 'Cliente Novo' });
  });
});

/**
 * Finding 3 da revisão final: o outro lado da invariante no CLAIM.
 *
 * A listagem já esconde o lead NOVO sem dono do operador no modo individual
 * (`lead-visibility.ts`: a nuvem é `returned_at != null`), mas o `claim`
 * gateava só em `responsavel_id: null` — quem tivesse o id (link, WebSocket,
 * um lead que passou pela tela antes de ser distribuído) furava a fila do
 * gerente por baixo. Agora o `where` do updateMany carrega
 * `returned_at: { not: null }` quando é operador E o tenant está no individual.
 *
 * Gerente segue distribuindo lead novo, e o modo compartilhado (pool) não muda:
 * lá lead novo sem dono é do pool, de todo mundo, por definição.
 */
describe('claim — no modo individual o operador só pega da NUVEM', () => {
  it('operador + individual + lead NOVO: 409 (o where exige returned_at)', async () => {
    const { service, prisma, txClient } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    // Lead novo não casa o `returned_at: { not: null }` → nenhuma linha.
    txClient.lead.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.claim('lead-1', alex)).rejects.toBeInstanceOf(ConflictException);

    expect(whereDoUpdateMany(txClient.lead.updateMany)).toEqual({
      id: 'lead-1',
      tenant_id: 't1',
      responsavel_id: { equals: null },
      returned_at: { not: null },
    });
  });

  it('operador + individual + lead DA NUVEM: assume normalmente', async () => {
    const { service, prisma, txClient } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });

    const r = await service.claim('lead-1', alex);

    expect(r.responsavel_id).toBe('u-alex');
    expect(whereDoUpdateMany(txClient.lead.updateMany).returned_at).toEqual({ not: null });
    // E continua saindo da nuvem ao ser assumido.
    expect(dataDoUpdate(txClient.lead.updateMany).returned_at).toBeNull();
  });

  it('gerente + individual + lead NOVO: distribuir continua sendo papel dele', async () => {
    const { service, prisma, txClient } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });

    await service.claim('lead-1', gerente);

    expect(whereDoUpdateMany(txClient.lead.updateMany)).toEqual({
      id: 'lead-1',
      tenant_id: 't1',
      responsavel_id: { equals: null },
    });
  });

  it('operador + COMPARTILHADO: pool é de todos, o where não muda', async () => {
    const { service, prisma, txClient } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true });

    await service.claim('lead-1', alex);

    expect(whereDoUpdateMany(txClient.lead.updateMany)).toEqual({
      id: 'lead-1',
      tenant_id: 't1',
      responsavel_id: { equals: null },
    });
  });
});

/**
 * O ramo `null` do `patchDaNuvem` é inalcançável pela ficha hoje (o schema come
 * o null antes), então ele é testado direto: é ele que garante que, no dia em
 * que uma devolução por PATCH existir, ela CARIMBE em vez de limpar o carimbo —
 * e que não deixe o lead privado, que é o mesmo furo do `deleteUser` e do
 * espelho de conversa órfã.
 */
describe('patchDaNuvem — os dois lados da invariante', () => {
  it('com dono: só limpa o carimbo', () => {
    expect(patchDaNuvem('u-alex')).toEqual({ returned_at: null });
  });

  it('sem dono: carimba, libera privacidade e zera o corte de histórico', () => {
    expect(patchDaNuvem(null)).toEqual({
      returned_at: expect.any(Date),
      is_private: false,
      assumed_at: null,
    });
  });
});
