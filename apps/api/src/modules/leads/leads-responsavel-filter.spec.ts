import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { RedisCacheService } from '../../common/cache/redis-cache.service';
import type { InstancesService } from '../instances/instances.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { MediaService } from '../media/media.service';
import type { PushService } from '../push/push.service';
import type { OutboundWebhooksService } from '../outbound-webhooks/outbound-webhooks.service';
import type { AssignmentService } from '../queue/assignment.service';
import type { CustomFieldsService } from './custom-fields.service';
import type { Queue } from 'bullmq';
import type { Response } from 'express';

/**
 * Rede de regressão do param `responsavel_id` em `findAll` e `exportCsv`.
 *
 * Dois furos reais fechados aqui, ambos da mesma forma: o param do cliente
 * SOBRESCREVIA o recorte de visibilidade (`where.responsavel_id = ...`), então
 * bastava um `?responsavel_id=<id-do-colega>` para um OPERADOR listar — e
 * exportar em CSV — a carteira alheia.
 *
 * A regra que substituiu isso tem DOIS ramos, e os dois precisam de rede:
 * - auto-filtro (`=== user.id`) é sempre permitido, porque só ESTREITA. A aba
 *   "Minhas" do chat manda esse param para todo mundo; barrá-lo devolveria
 *   lead do pool dentro de "Minhas".
 * - recorte por OUTRO responsável ("Ver como membro") só para gerente
 *   SUPERVISIONANDO — gerente em modo foco abriu mão da supervisão e é tratado
 *   como operador.
 */

interface PrismaMock {
  tenant: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  lead: { findMany: jest.Mock };
}

interface CacheMock {
  get: jest.Mock;
  set: jest.Mock;
  delPattern: jest.Mock;
}

const naoUsado = <T>(): T => ({}) as T;

function makeService() {
  const prisma: PrismaMock = {
    // Modo INDIVIDUAL em todos os casos: é onde o furo doía.
    tenant: { findUnique: jest.fn().mockResolvedValue({ pool_enabled: false }) },
    user: { findUnique: jest.fn().mockResolvedValue({ focus_mode: false }) },
    lead: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const cache: CacheMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delPattern: jest.fn().mockResolvedValue(undefined),
  };
  const service = new LeadsService(
    prisma as unknown as PrismaService,
    naoUsado<InstancesService>(),
    cache as unknown as RedisCacheService,
    naoUsado<CrmGateway>(),
    naoUsado<MediaService>(),
    naoUsado<PushService>(),
    naoUsado<OutboundWebhooksService>(),
    naoUsado<AssignmentService>(),
    naoUsado<CustomFieldsService>(),
    naoUsado<Queue>(),
  );
  return { service, prisma, cache };
}

const TENANT = 't1';
const OPERADOR_ID = 'u-operador';
const GERENTE_ID = 'u-gerente';
const COLEGA_ID = 'u-colega';

function makeUser(id: string, role: UserRole): AuthUser {
  return {
    id,
    nome: id,
    email: `${id}@x.com`,
    role: role as unknown as AuthUser['role'],
    ativo: true,
    tenantId: TENANT,
  };
}

const operador = makeUser(OPERADOR_ID, UserRole.OPERADOR);
const gerente = makeUser(GERENTE_ID, UserRole.GERENTE);

/** Visibilidade do operador no modo individual: as próprias + a nuvem. */
const OR_OPERADOR = (userId: string) => [
  { responsavel_id: userId },
  { responsavel_id: null, returned_at: { not: null }, is_private: false },
];

/** Visibilidade de quem supervisiona: tudo que não for privado de outro. */
const OR_SUPERVISAO = (userId: string) => [
  { is_private: false },
  { responsavel_id: userId },
];

/** Gerente em modo foco: as próprias + qualquer sem-dono (pra distribuir). */
const OR_GERENTE_FOCO = (userId: string) => [
  { responsavel_id: userId },
  { responsavel_id: null, is_private: false },
];

function whereDoFindMany(prisma: PrismaMock): Record<string, unknown> {
  expect(prisma.lead.findMany).toHaveBeenCalledTimes(1);
  const args = prisma.lead.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
  return args.where;
}

describe('LeadsService.findAll — param responsavel_id', () => {
  it('OPERADOR passando o id de OUTRO: param IGNORADO, sobra só a visibilidade dele', async () => {
    const { service, prisma } = makeService();

    await service.findAll(operador, { responsavel_id: COLEGA_ID });

    // Sem AND nenhum: o recorte pedido não entrou em lugar algum do where.
    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      OR: OR_OPERADOR(OPERADOR_ID),
    });
  });

  it('OPERADOR passando o PRÓPRIO id (aba "Minhas" do chat): honrado via AND', async () => {
    const { service, prisma } = makeService();

    await service.findAll(operador, { responsavel_id: OPERADOR_ID });

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      OR: OR_OPERADOR(OPERADOR_ID),
      AND: [{ responsavel_id: OPERADOR_ID }],
    });
  });

  it('GERENTE sem foco ("Ver como membro"): recorte por outro responsável honrado', async () => {
    const { service, prisma } = makeService();

    await service.findAll(gerente, { responsavel_id: COLEGA_ID });

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      OR: OR_SUPERVISAO(GERENTE_ID),
      AND: [{ responsavel_id: COLEGA_ID }],
    });
  });

  it('GERENTE com foco: abriu mão da supervisão, então o "Ver como" some junto', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ focus_mode: true });

    await service.findAll(gerente, { responsavel_id: COLEGA_ID });

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      OR: OR_GERENTE_FOCO(GERENTE_ID),
    });
  });

  it('GERENTE com foco ainda pode se auto-filtrar (a aba "Minhas" continua de pé)', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ focus_mode: true });

    await service.findAll(gerente, { responsavel_id: GERENTE_ID });

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      OR: OR_GERENTE_FOCO(GERENTE_ID),
      AND: [{ responsavel_id: GERENTE_ID }],
    });
  });

  it('busca textual + "Ver como": o recorte sobrevive ao mergeSearchCondition', async () => {
    const { service, prisma } = makeService();

    await service.findAll(gerente, { responsavel_id: COLEGA_ID, search: 'ana' });

    // mergeSearchCondition ATRIBUI where.AND do zero. Se o pushAnd do recorte
    // rodasse antes dele, este terceiro elemento não existiria e o gerente
    // veria os "ana" de todo mundo achando que estava vendo os do colega.
    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      AND: [
        { OR: OR_SUPERVISAO(GERENTE_ID) },
        {
          OR: [
            { nome: { contains: 'ana', mode: 'insensitive' } },
            { telefone: { contains: 'ana' } },
          ],
        },
        { responsavel_id: COLEGA_ID },
      ],
    });
  });

  it('cache separa board focado de board de supervisão (mesmo user, mesmos filtros)', async () => {
    const { service, prisma, cache } = makeService();

    await service.findAll(gerente, {});
    prisma.user.findUnique.mockResolvedValue({ focus_mode: true });
    await service.findAll(gerente, {});

    const [semFoco, comFoco] = cache.set.mock.calls.map((c) => c[0] as string);
    expect(semFoco).not.toEqual(comFoco);
  });
});

describe('LeadsService.exportCsv — param responsavel_id', () => {
  function makeRes() {
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };
    return res as unknown as Response & { setHeader: jest.Mock; send: jest.Mock };
  }

  it('OPERADOR NÃO exporta a carteira do colega: o clamp resiste ao param', async () => {
    const { service, prisma } = makeService();

    await service.exportCsv(operador, { responsavel_id: COLEGA_ID }, makeRes());

    // O bug: esta linha era `where.responsavel_id = filters.responsavel_id`,
    // sobrescrevendo o clamp de OPERADOR posto logo acima dela.
    // O OR de privacidade entra em TODA exportação (ver suíte de privacidade
    // abaixo); aqui ele é redundante com o clamp, mas precisa estar.
    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      responsavel_id: OPERADOR_ID,
      OR: OR_SUPERVISAO(OPERADOR_ID),
    });
  });

  it('OPERADOR exportando os PRÓPRIOS: honrado (não alarga nada)', async () => {
    const { service, prisma } = makeService();

    await service.exportCsv(operador, { responsavel_id: OPERADOR_ID }, makeRes());

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      responsavel_id: OPERADOR_ID,
      OR: OR_SUPERVISAO(OPERADOR_ID),
    });
  });

  it('GERENTE sem foco exporta a carteira de um membro — menos o privado dela', async () => {
    const { service, prisma } = makeService();

    await service.exportCsv(gerente, { responsavel_id: COLEGA_ID }, makeRes());

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      responsavel_id: COLEGA_ID,
      OR: OR_SUPERVISAO(GERENTE_ID),
    });
  });

  it('GERENTE com foco: sem supervisão, sem exportar a carteira alheia', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ focus_mode: true });

    await service.exportCsv(gerente, { responsavel_id: COLEGA_ID }, makeRes());

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      OR: OR_SUPERVISAO(GERENTE_ID),
    });
  });
});

/**
 * Finding 2 da revisão final: "lead privado continua regra suprema" valia na
 * LISTAGEM (`buildVisibilityWhere`) mas NÃO no CSV — o `where` do exportCsv era
 * plano, sem nenhuma condição de privacidade. Um gerente (ou o "Ver como
 * membro", que é o mesmo caminho com `?responsavel_id=<colega>`) baixava o lead
 * PRIVADO de outra pessoa em texto puro.
 *
 * O recorte é o mesmo da supervisão: `is_private: false` OU eu sou o dono —
 * Prisma faz AND das chaves de topo com o OR, então o privado do colega cai
 * fora e o MEU privado continua entrando.
 */
describe('LeadsService.exportCsv — privado de outro fica fora do CSV', () => {
  function makeRes() {
    const res = { setHeader: jest.fn(), send: jest.fn() };
    return res as unknown as Response & { setHeader: jest.Mock; send: jest.Mock };
  }

  it('GERENTE: o CSV exige "não privado OU meu" — privado do colega excluído', async () => {
    const { service, prisma } = makeService();

    await service.exportCsv(gerente, {}, makeRes());

    const where = whereDoFindMany(prisma);
    expect(where.OR).toEqual([
      { is_private: false },
      // ...e o privado do PRÓPRIO gerente segue no CSV por este ramo.
      { responsavel_id: GERENTE_ID },
    ]);
  });

  it('"Ver como membro": privado do colega continua fora (AND com o recorte)', async () => {
    const { service, prisma } = makeService();

    await service.exportCsv(gerente, { responsavel_id: COLEGA_ID }, makeRes());

    const where = whereDoFindMany(prisma);
    expect(where.responsavel_id).toBe(COLEGA_ID);
    expect(where.OR).toEqual(OR_SUPERVISAO(GERENTE_ID));
    // Nenhum ramo do OR casa um lead privado do colega: `is_private:false`
    // não casa (ele é privado) e `responsavel_id: GERENTE_ID` conflita com o
    // recorte `responsavel_id: COLEGA_ID` do topo.
  });

  it('OPERADOR: o clamp da própria carteira convive com o OR (o meu privado entra)', async () => {
    const { service, prisma } = makeService();

    await service.exportCsv(operador, {}, makeRes());

    expect(whereDoFindMany(prisma)).toEqual({
      tenant_id: TENANT,
      responsavel_id: OPERADOR_ID,
      OR: OR_SUPERVISAO(OPERADOR_ID),
    });
  });
});
