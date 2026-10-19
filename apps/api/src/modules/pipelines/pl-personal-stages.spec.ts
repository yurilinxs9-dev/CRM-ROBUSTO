import { ConflictException } from '@nestjs/common';
import { KanbanIndividualService } from './kanban-individual.service';
import { PL_PIPELINE, PL_TENANT } from '../pl-sales/pl-sales.domain';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CrmGateway } from '../websocket/websocket.gateway';

type Stage = { id: string; tenant_id: string; pipeline_id: string; user_id: string | null; nome: string; ordem: number; is_won: boolean; is_lost: boolean; cor: string };
const stage = (id: string, owner: string | null, name: string, won = false): Stage => ({ id, tenant_id: PL_TENANT, pipeline_id: PL_PIPELINE, user_id: owner, nome: name, ordem: won ? 1 : 0, is_won: won, is_lost: false, cor: '#123456' });
function setup(on = false) {
  const rows: Stage[] = [stage('base-new', null, 'Novo'), stage('base-won', null, 'Contrato fechado', true)];
  const users = [{ id: 'seller', tenant_id: PL_TENANT, role: 'OPERADOR', ativo: true, pl_sales_only: true }, { id: 'ordinary', tenant_id: PL_TENANT, role: 'OPERADOR', ativo: true, pl_sales_only: false }];
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, value]) => {
    if (key === 'NOT') return !match(row, value as Record<string, unknown>);
    if (value && typeof value === 'object') {
      const filter = value as { equals?: string; in?: unknown[]; not?: unknown };
      if (filter.equals !== undefined) return String(row[key]).toLowerCase() === filter.equals.toLowerCase();
      if (filter.in) return filter.in.includes(row[key]);
      if ('not' in filter) return row[key] !== filter.not;
    }
    return row[key] === value;
  });
  const prisma = {
    tenant: { findUnique: jest.fn(async () => ({ kanban_individual: on })), update: jest.fn() },
    user: {
      findFirst: jest.fn(async ({ where }) => users.find(u => match(u, where)) ?? null),
      findMany: jest.fn(async ({ where }) => users.filter(u => match(u, where))),
    },
    stage: {
      findFirst: jest.fn(async ({ where }) => rows.filter(s => match(s, where)).sort((a, b) => a.ordem - b.ordem)[0] ?? null),
      findMany: jest.fn(async ({ where }) => rows.filter(s => match(s, where))),
      create: jest.fn(async ({ data }) => { const s = { ...data, id: 'clone-' + rows.length }; rows.push(s); return s; }),
      deleteMany: jest.fn(async ({ where }) => { const removed = rows.filter(s => match(s, where)); for (const row of removed) rows.splice(rows.indexOf(row), 1); return { count: removed.length }; }),
    },
    lead: { updateMany: jest.fn(async (_args: { where: { responsavel_id?: string; pipeline_id?: string; estagio_id?: string }; data: Record<string, unknown> }) => ({ count: 0 })) },
    broadcast: { updateMany: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async callback => callback(prisma));
  const gateway = { emitKanbanIndividualChanged: jest.fn() };
  const service = new KanbanIndividualService(prisma as unknown as PrismaService, gateway as unknown as CrmGateway);
  return { service, prisma, rows, users };
}

describe('personal PL boards with the workspace toggle off', () => {
  it('maps an assigned lead into the opted-in seller board without enabling the workspace toggle', async () => {
    const { service, rows, prisma } = setup();
    const id = await service.stageForOwner(PL_TENANT, 'seller', 'base-new');
    expect(rows.find(row => row.id === id)).toMatchObject({ user_id: 'seller', nome: 'Novo', pipeline_id: PL_PIPELINE });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany.mock.calls.every(([arg]) => arg.where.responsavel_id === 'seller' && arg.where.pipeline_id === PL_PIPELINE)).toBe(true);
  });

  it('keeps existing customization and locks the initial copy before checking again', async () => {
    const { service, rows, prisma } = setup();
    await service.stageForOwner(PL_TENANT, 'seller', 'base-new');
    const own = rows.find(row => row.user_id === 'seller' && !row.is_won)!;
    own.nome = 'Meu primeiro contato';
    await service.stageForOwner(PL_TENANT, 'seller', 'base-new');
    expect(rows.filter(row => row.user_id === 'seller')).toHaveLength(2);
    expect(own.nome).toBe('Meu primeiro contato');
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('maps a renamed won stage back to a won base stage for an ordinary destination', async () => {
    const { service, rows } = setup();
    rows.push(stage('personal-won', 'seller', 'Venda concluída por mim', true));
    await expect(service.stageForOwner(PL_TENANT, 'ordinary', 'personal-won')).resolves.toBe('base-won');
    await expect(service.stageForBase(PL_TENANT, 'personal-won')).resolves.toBe('base-won');
  });

  it('keeps a base lead on base for ordinary profiles and other pipelines', async () => {
    const { service, rows, prisma } = setup();
    rows.push({ ...stage('partner', null, 'Partner'), pipeline_id: 'partner-pipeline' });
    await expect(service.stageForOwner(PL_TENANT, 'ordinary', 'base-new')).resolves.toBe('base-new');
    await expect(service.stageForOwner(PL_TENANT, 'seller', 'partner')).resolves.toBe('partner');
    expect(prisma.stage.create).not.toHaveBeenCalled();
  });

  it('fails instead of turning a won lead into an open lead when no compatible destination exists', async () => {
    const { service, rows } = setup();
    rows.splice(rows.findIndex(s => s.id === 'base-won'), 1);
    rows.push(stage('personal-won', 'seller', 'Minha venda', true));
    await expect(service.stageForBase(PL_TENANT, 'personal-won')).rejects.toBeInstanceOf(ConflictException);
  });

  it('preserves PL personal columns when management disables workspace-wide individual mode', async () => {
    const { service, rows, prisma } = setup(true);
    rows.push(stage('personal', 'seller', 'Etapa personalizada'));
    rows.push({ ...stage('ordinary-personal', 'ordinary', 'Novo'), pipeline_id: PL_PIPELINE });
    await service.disable({ id: 'manager', tenantId: PL_TENANT, role: 'SUPER_ADMIN' } as Parameters<typeof service.disable>[0]);
    expect(rows.some(s => s.id === 'personal')).toBe(true);
    expect(rows.some(s => s.id === 'ordinary-personal')).toBe(false);
    expect(prisma.lead.updateMany.mock.calls.some(([arg]) => arg.where.estagio_id === 'personal')).toBe(false);
  });

  it('does not duplicate or reset an existing PL board when workspace-wide mode is enabled', async () => {
    const { service, rows } = setup();
    await service.ensurePlPersonalBoard(PL_TENANT, 'seller');
    const own = rows.filter(s => s.user_id === 'seller');
    own[0].nome = 'Contato personalizado';
    own[0].cor = '#ABCDEF';
    await service.enable({ id: 'manager', tenantId: PL_TENANT, role: 'SUPER_ADMIN' } as Parameters<typeof service.enable>[0]);
    expect(rows.filter(s => s.user_id === 'seller')).toEqual(own);
    expect(rows.filter(s => s.user_id === 'ordinary')).toHaveLength(2);
  });
});
