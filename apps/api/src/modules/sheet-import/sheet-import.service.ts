import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomFieldsService } from '../leads/custom-fields.service';
import { AttributionService } from '../attribution/attribution.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { parseCsv, type ImportedLead } from './sheet-import.parser';
import { CONSORTIUM_SOURCE, PARTNER_SOURCE, type SheetImportSource } from './sheet-import.source';
import { resolveConsortiumMatch } from './consortium-sheet.parser';

export interface RunContext {
  tenantId: string;
  pipelineId: string;
  stageId: string;
  instancia: string;
}

export interface RunSummary {
  total: number;
  novas: number;
  anexadas: number;
  puladas: number;
  erros: number;
  semMudanca: boolean;
}

/** Grupo "Formulário Meta" fica depois do "Principal" (ordem 0). */
const GRUPO_ORDEM = 10;
const MAX_TENTATIVAS = 3;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Importa leads da planilha pública do Meta Lead Ads para UM tenant,
 * configurado por env. Ver spec 2026-09-08-importacao-planilha-meta-design.md.
 */
@Injectable()
export class SheetImportService implements OnModuleInit {
  private readonly logger = new Logger(SheetImportService.name);
  private readonly tenantId: string;
  private readonly sheetId: string;
  private readonly gid: string;
  private readonly pipelineIdEnv: string;
  private readonly stageIdEnv: string;
  private running = false;
  /** Hash do último CSV processado sem erro; igual = planilha não mudou. */
  private lastHash: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly customFields: CustomFieldsService,
    private readonly attribution: AttributionService,
    private readonly gateway: CrmGateway,
    private readonly insights: LeadInsightsService,
    @Optional() @Inject('SHEET_IMPORT_SOURCE') private readonly source: SheetImportSource = PARTNER_SOURCE,
  ) {
    this.tenantId = source.tenantId ?? this.config.get<string>(`${source.prefix}_TENANT_ID`, '');
    this.sheetId = this.config.get<string>(`${source.prefix}_SHEET_ID`, '');
    this.gid = this.config.get<string>(`${source.prefix}_GID`, '');
    this.pipelineIdEnv = source.pipelineId ?? this.config.get<string>(`${source.prefix}_PIPELINE_ID`, '');
    this.stageIdEnv = source.conservativeDedupe ? '' : this.config.get<string>(`${source.prefix}_STAGE_ID`, '');
  }

  isEnabled(): boolean {
    return this.tenantId !== '' && this.sheetId !== '';
  }

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log('Importação de planilha desligada (SHEET_IMPORT_* ausente)');
      return;
    }
    // Primeira rodada logo após o boot: backfill e recuperação após restart.
    void this.tick();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.isEnabled() || this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (err) {
      this.logger.warn(`Importação da planilha falhou: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async resolveContext(): Promise<RunContext> {
    let pipelineId = this.pipelineIdEnv;
    if (pipelineId === '') {
      const pipeline = await this.prisma.pipeline.findFirst({
        where: { tenant_id: this.tenantId },
        orderBy: { ordem: 'asc' },
        select: { id: true },
      });
      if (!pipeline) throw new Error(`tenant ${this.tenantId} sem pipeline`);
      pipelineId = pipeline.id;
    }

    let stageId = this.stageIdEnv;
    if (stageId === '') {
      // Etapa BASE (user_id null): com kanban individual ligado, as cópias
      // pessoais têm o mesmo nome; lead sem dono pertence ao conjunto base.
      const stage = await this.prisma.stage.findFirst({
        where: { pipeline_id: pipelineId, tenant_id: this.tenantId, user_id: null },
        orderBy: { ordem: 'asc' },
        select: { id: true },
      });
      if (!stage) throw new Error(`pipeline ${pipelineId} sem etapa base`);
      stageId = stage.id;
    }

    // `ultimo_check` é nullable e o Postgres ordena DESC como NULLS FIRST: sem
    // `nulls: 'last'` uma instância nunca checada passaria na frente da mais
    // recente de verdade, e o desempate por `created_at` nunca valeria.
    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { tenant_id: this.tenantId },
      orderBy: [{ ultimo_check: { sort: 'desc', nulls: 'last' } }, { created_at: 'asc' }],
      select: { nome: true },
    });

    return { tenantId: this.tenantId, pipelineId, stageId, instancia: inst?.nome ?? '' };
  }

  /** Garante grupo "Formulário Meta" e as definições de IMPORT_FIELDS. Idempotente. */
  async ensureFieldDefs(tenantId: string): Promise<void> {
    await this.customFields.ensureTenantBootstrap(tenantId);

    const grupo =
      (await this.prisma.customFieldGroup.findFirst({
        where: { tenant_id: tenantId, escopo: 'LEAD', nome: this.source.group },
        select: { id: true },
      })) ??
      (await this.prisma.customFieldGroup.create({
        data: { tenant_id: tenantId, escopo: 'LEAD', nome: this.source.group, ordem: GRUPO_ORDEM },
      }));

    const existentes = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, escopo: 'LEAD', key: { in: this.source.fields.map((f) => f.key) } },
      select: { key: true },
    });
    const ocupadas = new Set(existentes.map((d) => d.key));
    const faltam = this.source.fields.filter((f) => !ocupadas.has(f.key));
    if (faltam.length === 0) return;

    await this.prisma.customFieldDef.createMany({
      data: faltam.map((f) => ({
        tenant_id: tenantId,
        escopo: 'LEAD' as const,
        key: f.key,
        nome: f.nome,
        tipo: f.tipo,
        options: f.options ?? undefined,
        ordem: f.ordem,
        group_id: grupo.id,
        active: true,
        visible: true,
        api_only: false,
      })),
      skipDuplicates: true,
    });
    this.logger.log(`Campos de ${this.source.group} criados no tenant ${tenantId}: ${faltam.map((f) => f.key).join(', ')}`);
  }

  /**
   * Cria o lead da linha ou anexa os dados a um lead existente com o mesmo
   * telefone no pipeline. Lead + atividade + tags + registro da linha saem numa
   * transação curta; WS, atribuição e ficha ficam fora e nunca lançam.
   */
  async processRow(lead: ImportedLead, ctx: RunContext): Promise<'created' | 'attached' | 'skipped'> {
    const dadosCustom = (await this.customFields.validateValues(lead.dadosCustom, ctx.tenantId, 'LEAD')) as Prisma.InputJsonObject;
    // Both sheet writers share this lock when PL is enabled. Partner-only tenants
    // keep their existing pipeline-local matching rules.
    const protectedImport = this.source.conservativeDedupe ||
      (ctx.tenantId === CONSORTIUM_SOURCE.tenantId && !!this.config.get<string>('PL_SHEET_IMPORT_SHEET_ID', ''));
    const result = await this.prisma.$transaction(async tx => {
      if (protectedImport) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId}))`;
        const seen = await tx.sheetImportRow.findUnique({
          where: { tenant_id_source_row_id: { tenant_id: ctx.tenantId, source_row_id: lead.sourceRowId } },
          select: { status: true },
        });
        if (seen?.status === 'ok' || seen?.status === 'skipped') return { kind: 'skipped' as const };
      }
      const existente = protectedImport
        ? resolveConsortiumMatch(await tx.lead.findMany({
            where: { tenant_id: ctx.tenantId },
            select: { id: true, telefone: true, pipeline_id: true, email: true, tags: true, dados_custom: true, updated_at: true },
          }), lead.telefone, lead.email, ctx.pipelineId)
        : await tx.lead.findUnique({
            where: { telefone_pipeline_scope: { telefone: lead.telefone, pipeline_id: ctx.pipelineId, lead_scope: ctx.tenantId } },
            select: { id: true, email: true, tags: true, dados_custom: true, updated_at: true },
          });
      const tagIds = await this.upsertTags(tx, ctx.tenantId, lead.tags);
      if (existente) {
        const atuais = (existente.dados_custom ?? {}) as Record<string, unknown>;
        const merged = { ...atuais };
        for (const [k, v] of Object.entries(dadosCustom)) {
          if (atuais[k] === undefined || atuais[k] === null || atuais[k] === '') merged[k] = v;
        }
        const tagsAtuais = Array.isArray(existente.tags) ? (existente.tags as string[]) : [];
        const data = {
          dados_custom: merged as Prisma.InputJsonObject,
          tags: [...new Set([...tagsAtuais, ...lead.tags])],
          ...(!existente.email && lead.email ? { email: lead.email } : {}),
        };
        if (protectedImport) {
          const changed = await tx.lead.updateMany({
            where: { id: existente.id, tenant_id: ctx.tenantId, updated_at: existente.updated_at }, data,
          });
          if (changed.count !== 1) throw new Error('Ficha alterada durante a importação; tentar novamente preservando a edição');
        } else {
          await tx.lead.update({ where: { id: existente.id }, data });
        }
        await tx.leadActivity.create({ data: {
          lead_id: existente.id, tenant_id: ctx.tenantId, tipo: 'lead_updated',
          descricao: `Dados do formulário Meta anexados. ${lead.atividadeTexto}`,
        } });
        await this.vincularTags(tx, existente.id, ctx.tenantId, tagIds);
        await this.registrarLinha(tx, ctx.tenantId, lead.sourceRowId, existente.id);
        return { kind: 'attached' as const, id: existente.id, data };
      }
      const agora = new Date();
      const novo = await tx.lead.create({ data: {
        nome: lead.nome, telefone: lead.telefone, email: lead.email,
        origem: 'IMPORT', temperatura: 'FRIO', responsavel_id: null,
        lead_scope: ctx.tenantId, tenant_id: ctx.tenantId, pipeline_id: ctx.pipelineId,
        estagio_id: ctx.stageId, estagio_entered_at: agora, position: -agora.getTime(),
        instancia_whatsapp: ctx.instancia, tags: lead.tags, dados_custom: dadosCustom,
      }, select: { id: true } });
      await tx.leadActivity.create({ data: {
        lead_id: novo.id, tenant_id: ctx.tenantId, tipo: 'lead_created',
        descricao: `Importado da planilha de leads (Meta Lead Ads). ${lead.atividadeTexto}`,
      } });
      await this.vincularTags(tx, novo.id, ctx.tenantId, tagIds);
      await this.registrarLinha(tx, ctx.tenantId, lead.sourceRowId, novo.id);
      return { kind: 'created' as const, id: novo.id };
    }, { maxWait: 5000, timeout: 15000 });

    // External side effects only after commit.
    if (result.kind === 'skipped') return 'skipped';
    if (result.kind === 'attached') {
      try { this.gateway.emitLeadUpdated(result.id, result.data, ctx.tenantId); }
      catch { this.logger.warn(`WS lead:updated falhou para ${result.id}`); }
      return 'attached';
    }
    try { this.gateway.emitLeadCreated(result.id, { pipeline_id: ctx.pipelineId, estagio_id: ctx.stageId }, ctx.tenantId); }
    catch { this.logger.warn(`WS lead:created falhou para ${result.id}`); }
    await this.attribution.recordFirstTouch(result.id, ctx.tenantId, lead.attribution);
    try { await this.insights.enfileirarImportado(result.id, ctx.tenantId); }
    catch { this.logger.warn(`Ficha IA não enfileirada para ${result.id}`); }
    return 'created';
  }

  private async upsertTags(tx: Prisma.TransactionClient, tenantId: string, nomes: string[]): Promise<string[]> {
    const unicos = [...new Set(nomes.map((n) => n.trim()).filter((n) => n !== ''))];
    if (unicos.length === 0) return [];
    const tags = await Promise.all(
      unicos.map((nome) =>
        tx.tag.upsert({
          where: { tenant_id_nome: { tenant_id: tenantId, nome } },
          update: {},
          create: { nome, tenant_id: tenantId },
          select: { id: true, nome: true },
        }),
      ),
    );
    return tags.map((t) => t.id);
  }

  private async vincularTags(
    tx: Prisma.TransactionClient,
    leadId: string,
    tenantId: string,
    tagIds: string[],
  ): Promise<void> {
    if (tagIds.length === 0) return;
    await tx.leadTag.createMany({
      data: tagIds.map((tag_id) => ({ lead_id: leadId, tag_id, tenant_id: tenantId })),
      skipDuplicates: true,
    });
  }

  private async registrarLinha(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceRowId: string,
    leadId: string,
  ): Promise<void> {
    await tx.sheetImportRow.upsert({
      where: { tenant_id_source_row_id: { tenant_id: tenantId, source_row_id: sourceRowId } },
      create: { tenant_id: tenantId, source_row_id: sourceRowId, lead_id: leadId, status: 'ok', detail: null },
      update: { lead_id: leadId, status: 'ok', detail: null },
    });
  }

  sheetUrl(): string {
    const base = `https://docs.google.com/spreadsheets/d/${this.sheetId}/export?format=csv`;
    return this.gid !== '' ? `${base}&gid=${encodeURIComponent(this.gid)}` : base;
  }

  private rowKey(id: string): string {
    return this.source.conservativeDedupe ? `consorcio:${this.sheetId}:${this.gid || '0'}:${id}` : id;
  }

  private async baixarCsv(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(this.sheetUrl(), { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar a planilha`);
      const texto = await res.text();
      // Planilha privada devolve a página de login do Google com status 200.
      const cabecalho = texto.slice(0, 2000);
      if (!cabecalho.includes('id') || !cabecalho.toLowerCase().includes('telefone') || cabecalho.trimStart().startsWith('<')) {
        throw new Error('planilha não está acessível por link público (resposta não é CSV com colunas id/Telefone)');
      }
      return texto;
    } finally {
      clearTimeout(timer);
    }
  }

  async run(): Promise<RunSummary> {
    const csv = await this.baixarCsv();
    const hash = createHash('sha256').update(csv).digest('hex');
    const rows = parseCsv(csv);
    const resumo: RunSummary = { total: rows.length, novas: 0, anexadas: 0, puladas: 0, erros: 0, semMudanca: false };

    if (hash === this.lastHash) {
      resumo.semMudanca = true;
      this.logger.debug('Planilha sem mudanças desde a última rodada');
      return resumo;
    }

    const vistas = await this.prisma.sheetImportRow.findMany({
      where: { tenant_id: this.tenantId },
      select: { source_row_id: true, status: true, attempts: true },
    });
    const registro = new Map(vistas.map((v) => [v.source_row_id, v]));

    const pendentes = rows.filter((row) => {
      const id = (row.id ?? '').trim();
      const visto = registro.get(this.rowKey(id));
      if (!visto) return true;
      return visto.status === 'error' && visto.attempts < MAX_TENTATIVAS;
    });

    if (pendentes.length > 0) {
      await this.ensureFieldDefs(this.tenantId);
      const ctx = await this.resolveContext();
      const processedIds = new Set<string>();

      for (const row of pendentes) {
        const sourceId = row.id?.trim();
        if (this.source.conservativeDedupe && sourceId) {
          if (processedIds.has(sourceId)) { resumo.puladas++; continue; }
          processedIds.add(sourceId);
        }
        const mapped = this.source.map(row);
        if (!mapped.ok) {
          const id = (row.id ?? '').trim() || `sem-id:${resumo.puladas}`;
          await this.marcarLinha(this.rowKey(id), 'skipped', mapped.motivo);
          resumo.puladas++;
          continue;
        }
        mapped.lead.sourceRowId = this.rowKey(mapped.lead.sourceRowId);
        try {
          const r = await this.processRow(mapped.lead, ctx);
          if (r === 'created') resumo.novas++;
          else if (r === 'attached') resumo.anexadas++;
          else resumo.puladas++;
        } catch (err) {
          resumo.erros++;
          const msg = (err as Error).message ?? String(err);
          this.logger.warn(`Linha ${mapped.lead.sourceRowId} falhou: ${msg}`);
          await this.marcarLinha(mapped.lead.sourceRowId, 'error', msg);
        }
      }
    }

    if (resumo.erros === 0) this.lastHash = hash;
    this.logger.log(
      `${this.source.group}: ${resumo.total} linhas, ${resumo.novas} novas, ${resumo.anexadas} anexadas, ${resumo.puladas} puladas, ${resumo.erros} erros`,
    );
    return resumo;
  }

  private async marcarLinha(sourceRowId: string, status: 'skipped' | 'error', detail: string): Promise<void> {
    const where = { tenant_id_source_row_id: { tenant_id: this.tenantId, source_row_id: sourceRowId } };
    const write = async (tx: Prisma.TransactionClient) => {
      await tx.sheetImportRow.upsert({
        where,
        create: { tenant_id: this.tenantId, source_row_id: sourceRowId, lead_id: null, status, detail, attempts: 1 },
        update: { status, detail, ...(status === 'error' ? { attempts: { increment: 1 } } : {}) },
      });
    };
    const protectedImport = this.source.conservativeDedupe ||
      (this.tenantId === CONSORTIUM_SOURCE.tenantId && !!this.config.get<string>('PL_SHEET_IMPORT_SHEET_ID', ''));
    if (!protectedImport) {
      if (status === 'skipped') {
        await this.prisma.sheetImportRow.upsert({ where,
          create: { tenant_id: this.tenantId, source_row_id: sourceRowId, lead_id: null, status, detail },
          update: { status, detail },
        });
      } else await write(this.prisma);
      return;
    }
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${this.tenantId}))`;
      const seen = await tx.sheetImportRow.findUnique({ where, select: { status: true } });
      if (seen?.status === 'ok' || seen?.status === 'skipped') return;
      await write(tx);
    }, { maxWait: 5000, timeout: 15000 });
  }

}
