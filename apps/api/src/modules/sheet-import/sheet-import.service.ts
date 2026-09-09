import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomFieldsService } from '../leads/custom-fields.service';
import { AttributionService } from '../attribution/attribution.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { IMPORT_FIELDS, IMPORT_GROUP_NAME } from './sheet-import.fields';
import { mapRow, parseCsv, type ImportedLead } from './sheet-import.parser';

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
  ) {
    this.tenantId = this.config.get<string>('SHEET_IMPORT_TENANT_ID', '');
    this.sheetId = this.config.get<string>('SHEET_IMPORT_SHEET_ID', '');
    this.gid = this.config.get<string>('SHEET_IMPORT_GID', '');
    this.pipelineIdEnv = this.config.get<string>('SHEET_IMPORT_PIPELINE_ID', '');
    this.stageIdEnv = this.config.get<string>('SHEET_IMPORT_STAGE_ID', '');
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
        where: { tenant_id: tenantId, escopo: 'LEAD', nome: IMPORT_GROUP_NAME },
        select: { id: true },
      })) ??
      (await this.prisma.customFieldGroup.create({
        data: { tenant_id: tenantId, escopo: 'LEAD', nome: IMPORT_GROUP_NAME, ordem: GRUPO_ORDEM },
      }));

    const existentes = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, escopo: 'LEAD', key: { in: IMPORT_FIELDS.map((f) => f.key) } },
      select: { key: true },
    });
    const ocupadas = new Set(existentes.map((d) => d.key));
    const faltam = IMPORT_FIELDS.filter((f) => !ocupadas.has(f.key));
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
    this.logger.log(`Campos do formulário Meta criados no tenant ${tenantId}: ${faltam.map((f) => f.key).join(', ')}`);
  }

  // run() e processRow() entram nas Tasks 6 e 7.
  async run(): Promise<RunSummary> {
    throw new Error('não implementado');
  }
}
