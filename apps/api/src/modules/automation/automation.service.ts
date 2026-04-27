import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { MessagesService } from '../messages/messages.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private prisma: PrismaService,
    private leads: LeadsService,
    private messages: MessagesService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processAutomations() {
    this.logger.debug('Iniciando processamento de automações (SLA e Cadência)...');
    
    // 1. Processar SLAs (Estouro de tempo na etapa)
    await this.processSLAs();

    // 2. Processar Cadências (Avisos programados)
    await this.processCadences();
  }

  private async processSLAs() {
    // Buscar etapas que possuem SLA configurado e ação de auto-mover
    const stagesWithSla = await this.prisma.stage.findMany({
      where: {
        AND: [
          { sla_config: { path: ['enabled'], equals: true } },
          { sla_config: { path: ['action'], equals: 'AUTO_MOVE' } }
        ]
      }
    });

    for (const stage of stagesWithSla) {
      const config = stage.sla_config as any;
      const now = new Date();
      const threshold = this.getThresholdDate(now, config.duration, config.unit);

      // Buscar leads que entraram na etapa antes do threshold e precisam ser movidos
      const leadsToMove = await this.prisma.lead.findMany({
        where: {
          estagio_id: stage.id,
          estagio_entered_at: { lt: threshold },
        },
        select: { id: true, tenant_id: true }
      });

      for (const lead of leadsToMove) {
        if (config.targetStageId) {
          this.logger.log(`SLA Estourado: Movendo lead ${lead.id} para etapa ${config.targetStageId}`);
          // updateStage parses `data` via Zod expecting { estagio_id, position? }
          // and uses user.tenantId in the WHERE clause — both were broken when
          // a bare stageId string and a stub user without tenantId were passed.
          await this.leads.updateStage(
            lead.id,
            { estagio_id: config.targetStageId },
            { id: 'SYSTEM', tenantId: lead.tenant_id, role: 'SUPER_ADMIN' } as AuthUser,
          );
        }
      }
    }
  }

  // Throttle AUTO: máx leads disparados por tick (1min) — evita rajada se muitos hit threshold juntos.
  private readonly AUTO_MAX_PER_TICK = 5;
  private readonly tenantSystemUserCache = new Map<string, AuthUser>();

  private async getTenantSystemUser(tenantId: string): Promise<AuthUser | null> {
    const cached = this.tenantSystemUserCache.get(tenantId);
    if (cached) return cached;
    const u = await this.prisma.user.findFirst({
      where: { tenant_id: tenantId, ativo: true, role: { in: ['SUPER_ADMIN', 'GERENTE'] } },
      orderBy: { created_at: 'asc' },
    });
    if (!u) return null;
    const auth = { id: u.id, tenantId: u.tenant_id, role: u.role, nome: u.nome } as AuthUser;
    this.tenantSystemUserCache.set(tenantId, auth);
    return auth;
  }

  private async processCadences() {
    const leadsWithActiveCadence = await this.prisma.lead.findMany({
      where: {
        estagio: {
          cadence_config: { path: ['enabled'], equals: true }
        }
      },
      include: { estagio: true },
      orderBy: { estagio_entered_at: 'asc' }, // FIFO
    });

    let autoFired = 0;

    for (const lead of leadsWithActiveCadence) {
      const config = lead.estagio.cadence_config as any;
      const steps = config.steps || [];
      const currentStepIndex = lead.cadence_step_index;

      if (currentStepIndex >= steps.length) continue;

      const nextStep = steps[currentStepIndex];
      const now = new Date();
      const referenceDate = lead.estagio_entered_at || lead.created_at;
      const scheduledTime = this.getScheduledDate(referenceDate, nextStep.duration, nextStep.unit);

      if (now >= scheduledTime) {
        if (nextStep.mode === 'AUTO') {
          if (autoFired >= this.AUTO_MAX_PER_TICK) {
            this.logger.debug(`Cadência AUTO: limite ${this.AUTO_MAX_PER_TICK}/tick atingido, restantes adiados para próximo ciclo`);
            break;
          }

          const lock = nextStep.safety_lock;
          if (lock?.enabled && lead.last_customer_message_at) {
            const lastMsgThreshold = this.getThresholdDate(now, lock.duration, lock.unit);
            if (lead.last_customer_message_at > lastMsgThreshold) {
              this.logger.debug(`Trava de Segurança: Abortando cadência para lead ${lead.id} (atividade recente)`);
              continue;
            }
          }

          const sysUser = await this.getTenantSystemUser(lead.tenant_id);
          if (!sysUser) {
            this.logger.warn(`Cadência AUTO: nenhum admin/gerente ativo no tenant ${lead.tenant_id}, pulando lead ${lead.id}`);
            continue;
          }

          this.logger.log(`Cadência AUTO: Disparando lead ${lead.id} (Passo ${currentStepIndex + 1})`);
          try {
            await this.messages.sendText({ lead_id: lead.id, content: nextStep.template }, sysUser);
            autoFired++;
          } catch (err) {
            this.logger.error(`Cadência AUTO: erro lead ${lead.id}: ${String(err)}`);
            continue;
          }
        } else {
          // MANUAL: gravar proximo_followup para exibir badge no card
          // Não avança cadence_step_index — aguarda o agente enviar a mensagem
          this.logger.debug(`Cadência MANUAL: Lead ${lead.id} aguardando ação humana no passo ${currentStepIndex + 1}`);
          if (!lead.proximo_followup) {
            await this.prisma.lead.update({
              where: { id: lead.id },
              data: { proximo_followup: scheduledTime },
            });
          }
          continue;
        }

        // AUTO: avança o index automaticamente
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { cadence_step_index: currentStepIndex + 1 }
        });
      }
    }
  }

  private getThresholdDate(now: Date, duration: number, unit: string): Date {
    const d = new Date(now);
    if (unit === 'MINUTES') d.setMinutes(d.getMinutes() - duration);
    else if (unit === 'HOURS') d.setHours(d.getHours() - duration);
    else if (unit === 'DAYS') d.setDate(d.getDate() - duration);
    return d;
  }

  private getScheduledDate(ref: Date, duration: number, unit: string): Date {
    const d = new Date(ref);
    if (unit === 'MINUTES') d.setMinutes(d.getMinutes() + duration);
    else if (unit === 'HOURS') d.setHours(d.getHours() + duration);
    else if (unit === 'DAYS') d.setDate(d.getDate() + duration);
    return d;
  }
}
