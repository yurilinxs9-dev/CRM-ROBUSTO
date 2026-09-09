import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CustomFieldsService } from '../leads/custom-fields.service';
import type { AttributionService } from '../attribution/attribution.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { SheetImportService } from './sheet-import.service';
import { IMPORT_FIELDS, IMPORT_GROUP_NAME } from './sheet-import.fields';

/**
 * Mocks na borda (Prisma, config, serviços vizinhos, fetch). O service é
 * exercitado de verdade. Sem `any`: cast uma vez no construtor.
 */
export function montar(env: Record<string, string | undefined> = {}) {
  const prisma = {
    customFieldGroup: { findFirst: jest.fn(), create: jest.fn() },
    customFieldDef: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    pipeline: { findFirst: jest.fn() },
    stage: { findFirst: jest.fn() },
    whatsappInstance: { findFirst: jest.fn() },
    sheetImportRow: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    lead: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    leadActivity: { create: jest.fn() },
    tag: { upsert: jest.fn() },
    leadTag: { createMany: jest.fn() },
    $transaction: jest.fn(),
  };
  // $transaction interativo: executa o callback com o próprio mock como tx.
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));

  const config = { get: jest.fn((k: string, d?: string) => env[k] ?? d) };
  const customFields = {
    ensureTenantBootstrap: jest.fn().mockResolvedValue(undefined),
    validateValues: jest.fn(async (v: Record<string, unknown>) => v),
  };
  const attribution = { recordFirstTouch: jest.fn().mockResolvedValue(undefined) };
  const gateway = { emitLeadCreated: jest.fn() };
  const insights = { enfileirarImportado: jest.fn().mockResolvedValue(undefined) };

  const service = new SheetImportService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    customFields as unknown as CustomFieldsService,
    attribution as unknown as AttributionService,
    gateway as unknown as CrmGateway,
    insights as unknown as LeadInsightsService,
  );
  return { service, prisma, config, customFields, attribution, gateway, insights };
}

const ENV_OK = {
  SHEET_IMPORT_TENANT_ID: 't1',
  SHEET_IMPORT_SHEET_ID: 'sheet-abc',
};

describe('SheetImportService config', () => {
  it('sem SHEET_IMPORT_TENANT_ID/SHEET_ID fica inerte', () => {
    expect(montar({}).service.isEnabled()).toBe(false);
    expect(montar({ SHEET_IMPORT_TENANT_ID: 't1' }).service.isEnabled()).toBe(false);
    expect(montar(ENV_OK).service.isEnabled()).toBe(true);
  });
});

describe('SheetImportService.resolveContext', () => {
  it('sem pipeline/stage na env usa primeiro pipeline, primeira etapa base e instância mais recente', async () => {
    const m = montar(ENV_OK);
    m.prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1' });
    m.prisma.stage.findFirst.mockResolvedValue({ id: 's1' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue({ nome: 'leads' });

    await expect(m.service.resolveContext()).resolves.toEqual({
      tenantId: 't1',
      pipelineId: 'p1',
      stageId: 's1',
      instancia: 'leads',
    });
    expect(m.prisma.stage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pipeline_id: 'p1', tenant_id: 't1', user_id: null } }),
    );
  });

  it('env com pipeline e stage explícitos vence', async () => {
    const m = montar({ ...ENV_OK, SHEET_IMPORT_PIPELINE_ID: 'pX', SHEET_IMPORT_STAGE_ID: 'sX' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue(null);
    const ctx = await m.service.resolveContext();
    expect(ctx).toEqual({ tenantId: 't1', pipelineId: 'pX', stageId: 'sX', instancia: '' });
    expect(m.prisma.pipeline.findFirst).not.toHaveBeenCalled();
  });

  it('ordena instâncias por ultimo_check desc com nulls last (nunca checada não vence)', async () => {
    const m = montar({ ...ENV_OK, SHEET_IMPORT_PIPELINE_ID: 'pX', SHEET_IMPORT_STAGE_ID: 'sX' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue({ nome: 'leads' });

    await m.service.resolveContext();

    expect(m.prisma.whatsappInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenant_id: 't1' },
        orderBy: [{ ultimo_check: { sort: 'desc', nulls: 'last' } }, { created_at: 'asc' }],
      }),
    );
  });

  it('tenant sem pipeline lança erro claro', async () => {
    const m = montar(ENV_OK);
    m.prisma.pipeline.findFirst.mockResolvedValue(null);
    await expect(m.service.resolveContext()).rejects.toThrow('sem pipeline');
  });
});

describe('SheetImportService.ensureFieldDefs', () => {
  it('cria grupo e só as definições que faltam', async () => {
    const m = montar(ENV_OK);
    m.prisma.customFieldGroup.findFirst.mockResolvedValue(null);
    m.prisma.customFieldGroup.create.mockResolvedValue({ id: 'g1' });
    m.prisma.customFieldDef.findMany.mockResolvedValue([{ key: 'cidade' }, { key: 'estado' }]);

    await m.service.ensureFieldDefs('t1');

    expect(m.customFields.ensureTenantBootstrap).toHaveBeenCalledWith('t1');
    expect(m.prisma.customFieldGroup.create).toHaveBeenCalledWith({
      data: { tenant_id: 't1', escopo: 'LEAD', nome: IMPORT_GROUP_NAME, ordem: 10 },
    });
    const [{ data }] = m.prisma.customFieldDef.createMany.mock.calls[0] as [{ data: Array<{ key: string }> }];
    const keys = data.map((d) => d.key);
    expect(keys).toEqual(IMPORT_FIELDS.map((f) => f.key).filter((k) => k !== 'cidade' && k !== 'estado'));
    expect(data.every((d) => 'group_id' in d && (d as { group_id: string }).group_id === 'g1')).toBe(true);
  });

  it('grupo já existente é reaproveitado e nada é criado se todas as chaves existem', async () => {
    const m = montar(ENV_OK);
    m.prisma.customFieldGroup.findFirst.mockResolvedValue({ id: 'g-existente' });
    m.prisma.customFieldDef.findMany.mockResolvedValue(IMPORT_FIELDS.map((f) => ({ key: f.key })));

    await m.service.ensureFieldDefs('t1');

    expect(m.prisma.customFieldGroup.create).not.toHaveBeenCalled();
    expect(m.prisma.customFieldDef.createMany).not.toHaveBeenCalled();
  });
});
