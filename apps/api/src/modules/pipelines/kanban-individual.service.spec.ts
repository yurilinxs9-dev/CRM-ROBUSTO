import { ConflictException, ForbiddenException } from '@nestjs/common';
import { KanbanIndividualService } from './kanban-individual.service';
import { KanbanIndividualModule } from './kanban-individual.module';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * O kanban individual troca o board unico do tenant por um board por membro:
 * cada um ganha uma copia das colunas base e os leads sob sua responsabilidade
 * migram para a copia. O perigo mora nos dois toggles — ligar sem remapear
 * deixa lead orfao na coluna do vizinho, desligar sem remapear quebra a FK de
 * Lead.estagio_id na hora de apagar as colunas pessoais. Por isso os testes
 * abaixo olham as chamadas de escrita do Prisma, nao o estado interno.
 */

const TENANT = 'tenant-1';

const gerente: AuthUser = {
  id: 'ger1',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as never,
  ativo: true,
  tenantId: TENANT,
};

const operador: AuthUser = { ...gerente, id: 'op1', nome: 'Isamara', role: UserRole.OPERADOR as never };

interface StageRow {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  pipeline_id: string;
  tenant_id: string;
  user_id: string | null;
  is_won: boolean;
  is_lost: boolean;
  max_dias: number | null;
  probabilidade: number | null;
  auto_action: unknown;
  campos_obrigatorios: unknown;
  sla_config: unknown;
  idle_alert_config: unknown;
  response_alert_config: unknown;
  on_entry_config: unknown;
  cadence_config: unknown;
}

function stage(over: Partial<StageRow> & { id: string; nome: string; ordem: number }): StageRow {
  return {
    cor: '#3498DB',
    pipeline_id: 'pipe-1',
    tenant_id: TENANT,
    user_id: null,
    is_won: false,
    is_lost: false,
    max_dias: null,
    probabilidade: null,
    auto_action: null,
    campos_obrigatorios: null,
    sla_config: null,
    idle_alert_config: null,
    response_alert_config: null,
    on_entry_config: null,
    cadence_config: null,
    ...over,
  };
}

type UserIdFiltro = string | null | { not: null };
type NomeFiltro = string | { equals: string; mode?: string };

interface StageWhere {
  id?: string;
  tenant_id?: string;
  pipeline_id?: string;
  user_id?: UserIdFiltro;
  nome?: NomeFiltro;
}

function bate(row: StageRow, where: StageWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.tenant_id !== undefined && row.tenant_id !== where.tenant_id) return false;
  if (where.pipeline_id !== undefined && row.pipeline_id !== where.pipeline_id) return false;
  if (where.user_id !== undefined) {
    const filtro = where.user_id;
    if (filtro === null) {
      if (row.user_id !== null) return false;
    } else if (typeof filtro === 'string') {
      if (row.user_id !== filtro) return false;
    } else if (row.user_id === null) {
      return false;
    }
  }
  if (where.nome !== undefined) {
    const alvo = typeof where.nome === 'string' ? where.nome : where.nome.equals;
    if (row.nome.toLowerCase() !== alvo.toLowerCase()) return false;
  }
  return true;
}

interface StageQuery {
  where: StageWhere;
  orderBy?: { ordem?: 'asc' | 'desc' };
}

interface CreateStageArgs {
  data: Partial<StageRow> & { nome: string; ordem: number; tenant_id: string; user_id: string };
}

interface MembroRow {
  id: string;
}

/**
 * Prisma mockado na mao: as colunas vivem num array e o mock filtra de verdade,
 * porque enable() precisa reler os clones que acabou de criar para montar o
 * mapa base -> pessoal.
 */
function montar(opts: { stages?: StageRow[]; membros?: MembroRow[]; ligado?: boolean } = {}) {
  const rows: StageRow[] = [...(opts.stages ?? [])];
  const membros: MembroRow[] = opts.membros ?? [];
  const ligado = opts.ligado ?? false;

  function buscar({ where, orderBy }: StageQuery): StageRow[] {
    const achados = rows.filter((r) => bate(r, where));
    if (orderBy?.ordem === 'asc') achados.sort((a, b) => a.ordem - b.ordem);
    if (orderBy?.ordem === 'desc') achados.sort((a, b) => b.ordem - a.ordem);
    return achados;
  }

  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ kanban_individual: ligado }),
      update: jest.fn().mockResolvedValue({ id: TENANT }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue(membros),
    },
    stage: {
      findMany: jest.fn((args: StageQuery) => Promise.resolve(buscar(args))),
      findFirst: jest.fn((args: StageQuery) => Promise.resolve(buscar(args)[0] ?? null)),
      create: jest.fn(({ data }: CreateStageArgs) => {
        const novo = stage({
          ...data,
          id: `c-${data.user_id}-${data.nome}`,
          nome: data.nome,
          ordem: data.ordem,
        });
        rows.push(novo);
        return Promise.resolve(novo);
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    broadcast: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma));

  return { service: new KanbanIndividualService(prisma as never), prisma, rows };
}

const BASE = [
  stage({ id: 'b1', nome: 'Novo', ordem: 0 }),
  stage({ id: 'b2', nome: 'Ganho', ordem: 1, is_won: true }),
];

describe('KanbanIndividualService.enable', () => {
  it('clona colunas base para cada membro e remapeia leads do responsavel', async () => {
    const { service, prisma } = montar({
      stages: BASE,
      membros: [{ id: 'op1' }, { id: 'ger1' }],
    });

    await service.enable(gerente);

    // 2 membros x 2 colunas base
    expect(prisma.stage.create).toHaveBeenCalledTimes(4);
    const criadas = prisma.stage.create.mock.calls.map(([arg]: [CreateStageArgs]) => arg.data);
    expect(criadas).toEqual([
      expect.objectContaining({ nome: 'Novo', ordem: 0, user_id: 'op1', tenant_id: TENANT, pipeline_id: 'pipe-1' }),
      expect.objectContaining({ nome: 'Ganho', ordem: 1, user_id: 'op1', is_won: true }),
      expect.objectContaining({ nome: 'Novo', ordem: 0, user_id: 'ger1' }),
      expect.objectContaining({ nome: 'Ganho', ordem: 1, user_id: 'ger1', is_won: true }),
    ]);

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, responsavel_id: 'op1', estagio_id: 'b1' },
      data: { estagio_id: 'c-op1-Novo' },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, responsavel_id: 'ger1', estagio_id: 'b2' },
      data: { estagio_id: 'c-ger1-Ganho' },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledTimes(4);

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { kanban_individual: true },
    });
  });

  it('so clona para membro ativo com papel operacional', async () => {
    const { service, prisma } = montar({ stages: BASE, membros: [{ id: 'op1' }] });

    await service.enable(gerente);

    expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        tenant_id: TENANT,
        ativo: true,
        role: { in: [UserRole.OPERADOR, UserRole.GERENTE, UserRole.SUPER_ADMIN] },
      },
    });
  });

  it('com toggle ja ligado lanca ConflictException e nao escreve nada', async () => {
    const { service, prisma } = montar({ stages: BASE, membros: [{ id: 'op1' }], ligado: true });

    await expect(service.enable(gerente)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.stage.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('operador leva 403 e nao liga nada', async () => {
    const { service, prisma } = montar({ stages: BASE, membros: [{ id: 'op1' }] });

    await expect(service.enable(operador)).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

describe('KanbanIndividualService.disable', () => {
  const pessoais = [
    stage({ id: 'p1', nome: 'Novo', ordem: 0, user_id: 'op1' }),
    stage({ id: 'p9', nome: 'Leds', ordem: 1, user_id: 'op1' }),
  ];

  it('remapeia por nome para a base, anula Broadcast.stage_id e apaga pessoais', async () => {
    const { service, prisma } = montar({
      stages: [stage({ id: 'b1', nome: 'Novo', ordem: 0 }), ...pessoais],
      ligado: true,
    });

    await service.disable(gerente);

    // nome igual -> b1; nome sem par -> primeira base (menor ordem)
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, estagio_id: 'p1' },
      data: { estagio_id: 'b1' },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, estagio_id: 'p9' },
      data: { estagio_id: 'b1' },
    });

    expect(prisma.broadcast.updateMany).toHaveBeenCalledWith({
      where: { stage_id: { in: ['p1', 'p9'] } },
      data: { stage_id: null },
    });

    expect(prisma.stage.deleteMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, user_id: { not: null } },
    });

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { kanban_individual: false },
    });
  });

  it('com toggle ja desligado lanca ConflictException', async () => {
    const { service, prisma } = montar({ stages: BASE, ligado: false });

    await expect(service.disable(gerente)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.stage.deleteMany).not.toHaveBeenCalled();
  });

  it('operador leva 403', async () => {
    const { service } = montar({ stages: BASE, ligado: true });

    await expect(service.disable(operador)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('KanbanIndividualService.stageForOwner', () => {
  it('devolve a coluna de mesmo nome do dono', async () => {
    const { service } = montar({
      stages: [
        stage({ id: 'b1', nome: 'Novo', ordem: 0 }),
        stage({ id: 'p1', nome: 'novo', ordem: 0, user_id: 'op1' }),
        stage({ id: 'p2', nome: 'Ganho', ordem: 1, user_id: 'op1' }),
      ],
      ligado: true,
    });

    await expect(service.stageForOwner(TENANT, 'op1', 'b1')).resolves.toBe('p1');
  });

  it('sem coluna de mesmo nome cai na primeira do dono', async () => {
    const { service } = montar({
      stages: [
        stage({ id: 'b7', nome: 'Leds', ordem: 3 }),
        stage({ id: 'p2', nome: 'Ganho', ordem: 1, user_id: 'op1' }),
        stage({ id: 'p1', nome: 'Novo', ordem: 0, user_id: 'op1' }),
      ],
      ligado: true,
    });

    await expect(service.stageForOwner(TENANT, 'op1', 'b7')).resolves.toBe('p1');
  });

  it('com toggle OFF devolve o proprio fromStageId', async () => {
    const { service, prisma } = montar({
      stages: [stage({ id: 'b1', nome: 'Novo', ordem: 0 }), stage({ id: 'p1', nome: 'Novo', ordem: 0, user_id: 'op1' })],
      ligado: false,
    });

    await expect(service.stageForOwner(TENANT, 'op1', 'b1')).resolves.toBe('b1');
    expect(prisma.stage.findFirst).not.toHaveBeenCalled();
  });

  it('coluna que ja e do dono nao muda', async () => {
    const { service } = montar({
      stages: [stage({ id: 'p1', nome: 'Novo', ordem: 0, user_id: 'op1' })],
      ligado: true,
    });

    await expect(service.stageForOwner(TENANT, 'op1', 'p1')).resolves.toBe('p1');
  });
});

describe('KanbanIndividualService.stageForBase', () => {
  it('devolve a base de mesmo nome', async () => {
    const { service } = montar({
      stages: [
        stage({ id: 'b1', nome: 'Novo', ordem: 0 }),
        stage({ id: 'b2', nome: 'Ganho', ordem: 1 }),
        stage({ id: 'p2', nome: 'ganho', ordem: 1, user_id: 'op1' }),
      ],
      ligado: true,
    });

    await expect(service.stageForBase(TENANT, 'p2')).resolves.toBe('b2');
  });

  it('sem par por nome cai na primeira base', async () => {
    const { service } = montar({
      stages: [
        stage({ id: 'b2', nome: 'Ganho', ordem: 1 }),
        stage({ id: 'b1', nome: 'Novo', ordem: 0 }),
        stage({ id: 'p9', nome: 'Leds', ordem: 5, user_id: 'op1' }),
      ],
      ligado: true,
    });

    await expect(service.stageForBase(TENANT, 'p9')).resolves.toBe('b1');
  });

  it('coluna que ja e base devolve ela mesma', async () => {
    const { service } = montar({ stages: BASE, ligado: true });

    await expect(service.stageForBase(TENANT, 'b1')).resolves.toBe('b1');
  });
});

/**
 * O modulo existe para ser importado por pipelines/leads/broadcasts. Se algum
 * dia ele passar a importar um modulo de dominio, volta o ciclo que ele foi
 * criado para evitar — por isso a lista de imports vazia e testada.
 */
describe('KanbanIndividualModule', () => {
  it('exporta o service e nao importa modulo de dominio nenhum', () => {
    const providers = Reflect.getMetadata('providers', KanbanIndividualModule) as unknown[];
    const exports = Reflect.getMetadata('exports', KanbanIndividualModule) as unknown[];
    const imports = Reflect.getMetadata('imports', KanbanIndividualModule) as unknown[] | undefined;

    expect(providers).toContain(KanbanIndividualService);
    expect(exports).toContain(KanbanIndividualService);
    expect(imports ?? []).toHaveLength(0);
  });
});

describe('KanbanIndividualService.isOn', () => {
  it('le a flag do tenant', async () => {
    const { service } = montar({ ligado: true });
    await expect(service.isOn(TENANT)).resolves.toBe(true);

    const desligado = montar({ ligado: false });
    await expect(desligado.service.isOn(TENANT)).resolves.toBe(false);
  });
});
