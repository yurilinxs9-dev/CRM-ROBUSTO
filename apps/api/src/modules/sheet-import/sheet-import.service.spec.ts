import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CustomFieldsService } from '../leads/custom-fields.service';
import type { AttributionService } from '../attribution/attribution.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { SheetImportService } from './sheet-import.service';
import { IMPORT_FIELDS, IMPORT_GROUP_NAME } from './sheet-import.fields';
import type { ImportedLead } from './sheet-import.parser';

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
  const gateway = { emitLeadCreated: jest.fn(), emitLeadUpdated: jest.fn() };
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

const CTX = { tenantId: 't1', pipelineId: 'p1', stageId: 's1', instancia: 'leads' };

function leadImportado(overrides: Partial<ImportedLead> = {}): ImportedLead {
  return {
    sourceRowId: 'l:100',
    nome: 'Eduardo',
    telefone: '5519997094696',
    email: 'e@x.com',
    companyType: 'MEI',
    dadosCustom: { tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei', cidade: 'Paulínia' },
    tags: ['MEI'],
    attribution: { utm_source: 'ig', utm_medium: 'paid', campaignid: '1' },
    atividadeTexto: 'Tipo de empresa: MEI (Mei) · Paulínia',
    ...overrides,
  };
}

describe('SheetImportService.processRow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T15:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('telefone novo: cria lead sem dono na etapa configurada, atividade, tags, registro, WS, atribuição e ficha', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockResolvedValue({ id: 'lead-novo' });
    m.prisma.tag.upsert.mockResolvedValue({ id: 'tag-mei', nome: 'MEI' });

    const r = await m.service.processRow(leadImportado(), CTX);

    expect(r).toBe('created');
    expect(m.customFields.validateValues).toHaveBeenCalledWith(
      { tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei', cidade: 'Paulínia' },
      't1',
      'LEAD',
    );
    const [{ data }] = m.prisma.lead.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      nome: 'Eduardo',
      telefone: '5519997094696',
      email: 'e@x.com',
      origem: 'IMPORT',
      temperatura: 'FRIO',
      responsavel_id: null,
      lead_scope: 't1',
      tenant_id: 't1',
      pipeline_id: 'p1',
      estagio_id: 's1',
      instancia_whatsapp: 'leads',
      tags: ['MEI'],
      dados_custom: { tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei', cidade: 'Paulínia' },
    });
    expect(data.position).toBe(-Date.now());
    expect(data.estagio_entered_at).toEqual(new Date());

    expect(m.prisma.leadActivity.create).toHaveBeenCalledWith({
      data: {
        lead_id: 'lead-novo',
        tenant_id: 't1',
        tipo: 'lead_created',
        descricao: 'Importado da planilha de leads (Meta Lead Ads). Tipo de empresa: MEI (Mei) · Paulínia',
      },
    });
    expect(m.prisma.tag.upsert).toHaveBeenCalledWith({
      where: { tenant_id_nome: { tenant_id: 't1', nome: 'MEI' } },
      update: {},
      create: { nome: 'MEI', tenant_id: 't1' },
      select: { id: true, nome: true },
    });
    expect(m.prisma.leadTag.createMany).toHaveBeenCalledWith({
      data: [{ lead_id: 'lead-novo', tag_id: 'tag-mei', tenant_id: 't1' }],
      skipDuplicates: true,
    });
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith({
      where: { tenant_id_source_row_id: { tenant_id: 't1', source_row_id: 'l:100' } },
      create: { tenant_id: 't1', source_row_id: 'l:100', lead_id: 'lead-novo', status: 'ok', detail: null },
      update: { lead_id: 'lead-novo', status: 'ok', detail: null },
    });
    expect(m.gateway.emitLeadCreated).toHaveBeenCalledWith('lead-novo', { pipeline_id: 'p1', estagio_id: 's1' }, 't1');
    expect(m.attribution.recordFirstTouch).toHaveBeenCalledWith('lead-novo', 't1', {
      utm_source: 'ig',
      utm_medium: 'paid',
      campaignid: '1',
    });
    expect(m.insights.enfileirarImportado).toHaveBeenCalledWith('lead-novo', 't1');
  });

  it('telefone já existe: anexa campos vazios, e-mail e tags; não cria, não muda etapa/dono, não enfileira ficha', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue({
      id: 'lead-velho',
      email: null,
      tags: ['VIP'],
      dados_custom: { cidade: 'Campinas' },
    });
    m.prisma.tag.upsert.mockResolvedValue({ id: 'tag-mei', nome: 'MEI' });

    const r = await m.service.processRow(leadImportado(), CTX);

    expect(r).toBe('attached');
    expect(m.gateway.emitLeadUpdated).toHaveBeenCalledWith('lead-velho', expect.objectContaining({ tags: ['VIP', 'MEI'] }), 't1');
    expect(m.prisma.lead.create).not.toHaveBeenCalled();
    const [{ where, data }] = m.prisma.lead.update.mock.calls[0] as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(where).toEqual({ id: 'lead-velho' });
    // cidade existente é preservada; chaves novas entram.
    expect(data.dados_custom).toEqual({ cidade: 'Campinas', tipo_empresa: 'MEI', tipo_empresa_resposta: 'Mei' });
    expect(data.email).toBe('e@x.com');
    expect(data.tags).toEqual(['VIP', 'MEI']);
    expect(data).not.toHaveProperty('estagio_id');
    expect(data).not.toHaveProperty('responsavel_id');
    expect(m.prisma.leadActivity.create).toHaveBeenCalledWith({
      data: {
        lead_id: 'lead-velho',
        tenant_id: 't1',
        tipo: 'lead_updated',
        descricao: 'Dados do formulário Meta anexados. Tipo de empresa: MEI (Mei) · Paulínia',
      },
    });
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { tenant_id: 't1', source_row_id: 'l:100', lead_id: 'lead-velho', status: 'ok', detail: null },
      }),
    );
    expect(m.gateway.emitLeadCreated).not.toHaveBeenCalled();
    expect(m.attribution.recordFirstTouch).not.toHaveBeenCalled();
    expect(m.insights.enfileirarImportado).not.toHaveBeenCalled();
  });

  it('lead existente com e-mail mantém o e-mail dele', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue({ id: 'l', email: 'dono@x.com', tags: [], dados_custom: {} });
    await m.service.processRow(leadImportado({ tags: [] }), CTX);
    const [{ data }] = m.prisma.lead.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).not.toHaveProperty('email');
  });

  it('sem tags não chama tag.upsert nem leadTag.createMany', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockResolvedValue({ id: 'n' });
    await m.service.processRow(leadImportado({ tags: [], companyType: 'ME_LTDA' }), CTX);
    expect(m.prisma.tag.upsert).not.toHaveBeenCalled();
    expect(m.prisma.leadTag.createMany).not.toHaveBeenCalled();
  });

  it('falha na atribuição ou no WS não derruba o processamento (lead já gravado)', async () => {
    const m = montar(ENV_OK);
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockResolvedValue({ id: 'n' });
    m.gateway.emitLeadCreated.mockImplementation(() => {
      throw new Error('socket caiu');
    });
    m.insights.enfileirarImportado.mockRejectedValue(new Error('redis caiu'));
    await expect(m.service.processRow(leadImportado({ tags: [] }), CTX)).resolves.toBe('created');
  });
});

const CSV_HEADER =
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,há_quantos_anos_na_atua_com_vendas_de_consórcio?,possui_estrutura_física?,tem_quantos_vendedores?,média_de_produção_mensal?,sua_empresa_é_mei_ou_ltda?,Email,Nome Completo,Telefone,Cidade,estado,lead_status';
const LINHA_A = 'l:1,2026-09-04T11:17:13-05:00,ag:1,02,as:1,Conj,c:1,Camp,f:1,Form,false,ig,3 anos,Não,1,500 mil,Mei,a@x.com,Ana,p:+5519997094696,Paulínia,SP,CREATED';
const LINHA_B = 'l:2,2026-09-04T12:00:00-05:00,ag:1,02,as:1,Conj,c:1,Camp,f:1,Form,false,ig,1,Sim,2,100 mil,Ltda,b@x.com,Bia,p:11945550754,São Paulo,SP,CREATED';
const LINHA_TESTE =
  'l:9,2026-06-22T15:34:49-05:00,,,,,,,f:1,Form,true,,<test lead: dummy data for x>,<test lead: dummy data for y>,x,y,z,test@meta.com,<test lead: dummy data for Nome Completo>,p:<test lead: dummy data for Telefone>,c,e,ok';

function respostaCsv(texto: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => texto };
}

describe('SheetImportService.run', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function prepararFeliz(csv: string) {
    const m = montar(ENV_OK);
    fetchMock.mockResolvedValue(respostaCsv(csv));
    m.prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1' });
    m.prisma.stage.findFirst.mockResolvedValue({ id: 's1' });
    m.prisma.whatsappInstance.findFirst.mockResolvedValue({ nome: 'leads' });
    m.prisma.customFieldGroup.findFirst.mockResolvedValue({ id: 'g1' });
    m.prisma.customFieldDef.findMany.mockResolvedValue(IMPORT_FIELDS.map((f) => ({ key: f.key })));
    m.prisma.lead.findUnique.mockResolvedValue(null);
    m.prisma.lead.create.mockImplementation(async ({ data }: { data: { telefone: string } }) => ({ id: `lead-${data.telefone}` }));
    m.prisma.tag.upsert.mockResolvedValue({ id: 'tag', nome: 'MEI' });
    return m;
  }

  it('monta a URL de export com gid opcional', () => {
    expect(montar(ENV_OK).service.sheetUrl()).toBe(
      'https://docs.google.com/spreadsheets/d/sheet-abc/export?format=csv',
    );
    expect(montar({ ...ENV_OK, SHEET_IMPORT_GID: '77' }).service.sheetUrl()).toBe(
      'https://docs.google.com/spreadsheets/d/sheet-abc/export?format=csv&gid=77',
    );
  });

  it('primeira rodada: cria as linhas reais, registra a de teste como skipped e resume', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A, LINHA_B, LINHA_TESTE].join('\n'));

    const r = await m.service.run();

    expect(r).toEqual({ total: 3, novas: 2, anexadas: 0, puladas: 1, erros: 0, semMudanca: false });
    expect(m.prisma.lead.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith({
      where: { tenant_id_source_row_id: { tenant_id: 't1', source_row_id: 'l:9' } },
      create: { tenant_id: 't1', source_row_id: 'l:9', lead_id: null, status: 'skipped', detail: 'linha de teste do Meta' },
      update: { status: 'skipped', detail: 'linha de teste do Meta' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://docs.google.com/spreadsheets/d/sheet-abc/export?format=csv',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('linhas já registradas (ok/skipped) não são reprocessadas; error com attempts < 3 é retentada', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A, LINHA_B, LINHA_TESTE].join('\n'));
    m.prisma.sheetImportRow.findMany.mockResolvedValue([
      { source_row_id: 'l:1', status: 'ok', attempts: 1 },
      { source_row_id: 'l:9', status: 'skipped', attempts: 1 },
      { source_row_id: 'l:2', status: 'error', attempts: 2 },
    ]);

    const r = await m.service.run();

    expect(r.novas).toBe(1);
    expect(m.prisma.lead.create).toHaveBeenCalledTimes(1);
    const [{ data }] = m.prisma.lead.create.mock.calls[0] as [{ data: { telefone: string } }];
    expect(data.telefone).toBe('5511945550754');
  });

  it('error com attempts >= 3 não é retentada', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_B].join('\n'));
    m.prisma.sheetImportRow.findMany.mockResolvedValue([{ source_row_id: 'l:2', status: 'error', attempts: 3 }]);
    const r = await m.service.run();
    expect(r).toEqual({ total: 1, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: false });
    expect(m.prisma.lead.create).not.toHaveBeenCalled();
  });

  it('erro numa linha grava status error com attempts incrementado e segue as outras', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A, LINHA_B].join('\n'));
    m.prisma.$transaction
      .mockImplementationOnce(async () => {
        throw new Error('deadlock');
      })
      .mockImplementation(async (fn: (tx: typeof m.prisma) => Promise<unknown>) => fn(m.prisma));

    const r = await m.service.run();

    expect(r.novas).toBe(1);
    expect(r.erros).toBe(1);
    expect(m.prisma.sheetImportRow.upsert).toHaveBeenCalledWith({
      where: { tenant_id_source_row_id: { tenant_id: 't1', source_row_id: 'l:1' } },
      create: { tenant_id: 't1', source_row_id: 'l:1', lead_id: null, status: 'error', detail: 'deadlock', attempts: 1 },
      update: { status: 'error', detail: 'deadlock', attempts: { increment: 1 } },
    });
  });

  it('hash igual ao da rodada anterior sem erros encerra sem consultar o banco', async () => {
    const csv = [CSV_HEADER, LINHA_A].join('\n');
    const m = prepararFeliz(csv);
    await m.service.run();
    m.prisma.sheetImportRow.findMany.mockClear();

    const r = await m.service.run();

    expect(r).toEqual({ total: 1, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: true });
    expect(m.prisma.sheetImportRow.findMany).not.toHaveBeenCalled();
  });

  it('rodada com erro NÃO grava o hash: a próxima reprocessa', async () => {
    const m = prepararFeliz([CSV_HEADER, LINHA_A].join('\n'));
    m.prisma.$transaction.mockImplementationOnce(async () => {
      throw new Error('x');
    });
    await m.service.run();
    const r = await m.service.run();
    expect(r.semMudanca).toBe(false);
  });

  it('HTTP não-2xx lança e nada é registrado', async () => {
    const m = montar(ENV_OK);
    fetchMock.mockResolvedValue(respostaCsv('', 403));
    await expect(m.service.run()).rejects.toThrow('HTTP 403');
    expect(m.prisma.sheetImportRow.upsert).not.toHaveBeenCalled();
  });

  it('HTML de login (planilha privada) é tratado como falha de download', async () => {
    const m = montar(ENV_OK);
    fetchMock.mockResolvedValue(respostaCsv('<!DOCTYPE html><html><head><title>Google Accounts</title>'));
    await expect(m.service.run()).rejects.toThrow('planilha não está acessível por link público');
  });

  it('CSV sem linhas de dados resume zero sem erro', async () => {
    const m = prepararFeliz(CSV_HEADER);
    await expect(m.service.run()).resolves.toEqual({ total: 0, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: false });
  });
});
