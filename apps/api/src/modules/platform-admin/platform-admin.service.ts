import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { deriveBillingStatus, addCycleMonths, monthlyCents, dayInTz } from './billing-status';

/** Fuso da operação — mesmo default de `deriveBillingStatus`. */
const BILLING_TZ = 'America/Sao_Paulo';
const NOON_MS = 12 * 3_600_000;

const announcementSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  level: z.enum(['INFO', 'WARNING', 'MAINTENANCE']).optional().default('INFO'),
  target_tenant_id: z.string().uuid().optional().nullable(),
  expires_at: z.string().datetime().optional().nullable(),
});

const billingSchema = z.object({
  // Teto = int4 da coluna. Sem ele o Prisma estoura com erro de driver (500)
  // em vez de 400, e o painel mostra "erro interno" para um dígito a mais.
  billing_value: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  billing_cycle_months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).nullable().optional(),
  billing_paid_until: z.string().datetime().nullable().optional(),
});

/**
 * `billing_paid_until` é um DIA de calendário guardado em TIMESTAMP(3) naive.
 * Ancorar no MEIO-DIA UTC mantém o mesmo dia em qualquer leitura com
 * deslocamento de até ±12h; meia-noite UTC leria como o dia anterior em São
 * Paulo (UTC-3) — o cliente veria "vence dia 9" tendo pago até o dia 10.
 *
 * O painel já manda o ISO ancorado, mas a rota aceita qualquer cliente do
 * endpoint: se vier meia-noite exata (o formato natural de um `<input
 * type="date">` serializado), re-ancoramos aqui. Horário diferente de 00:00 é
 * intenção explícita e passa como veio.
 */
function anchorPaidUntil(iso: string): Date {
  const dt = new Date(iso);
  const midnightUtc =
    dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 && dt.getUTCSeconds() === 0 && dt.getUTCMilliseconds() === 0;
  if (!midnightUtc) return dt;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 12));
}

/** Provider efetivo de uma instância, deduzido do `config` (Json). */
export type InstanceProvider = 'uazapi' | 'evolution' | 'legado';

export interface InstanceHealthRow {
  tenant: string;
  nome: string;
  provider: InstanceProvider;
  status: string;
  ultimo_check: string | null;
  caida_desde: string | null;
}

/** `config` é Json: pode ser null, string, número ou array. Guard, nunca cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function temTexto(cfg: Record<string, unknown>, chave: string): boolean {
  const valor = cfg[chave];
  return typeof valor === 'string' && valor.length > 0;
}

/**
 * Mesma dedução do InstanceHealthService: quem tem token UazAPI é UazAPI, quem
 * tem token Evolution é Evolution, e quem não tem token nenhum é o WPPConnect
 * legado — sem gateway para perguntar, logo fora do monitor.
 */
function providerDaConfig(config: unknown): InstanceProvider {
  if (!isRecord(config)) return 'legado';
  if (temTexto(config, 'uazapi_token')) return 'uazapi';
  if (temTexto(config, 'evolution_token')) return 'evolution';
  return 'legado';
}

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * COUNT(*) pleno na Message custa ~5s (233k+ linhas, heap 162MB) e roda a
   * cada load do painel. Estatística de painel não precisa ser exata —
   * estimativa do planner (reltuples, atualizada pelo autovacuum) sai em <1ms.
   */
  private async estimatedMessageCount(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ estimate: number }[]>`
      SELECT reltuples::bigint::int AS estimate FROM pg_class WHERE relname = 'Message'`;
    return rows[0]?.estimate ?? 0;
  }

  // ---- Proteção do tenant do admin master -----------------------------------
  /**
   * Tenant "protegido" é o de qualquer admin de plataforma ativo com escopo
   * total. Derivar do dado (em vez de fixar um UUID) mantém a proteção válida
   * se o admin master mudar de tenant.
   */
  private async isProtectedTenant(tenantId: string): Promise<boolean> {
    const masters = await this.prisma.user.count({
      where: {
        tenant_id: tenantId,
        ativo: true,
        is_platform_admin: true,
        platform_scopes: { has: '*' },
      },
    });
    return masters > 0;
  }

  /**
   * Todos os tenants protegidos de uma vez — para filtrar a listagem sem ir ao
   * banco uma vez por tenant.
   */
  private async protectedTenantIds(): Promise<string[]> {
    const masters = await this.prisma.user.findMany({
      where: { ativo: true, is_platform_admin: true, platform_scopes: { has: '*' } },
      select: { tenant_id: true },
      distinct: ['tenant_id'],
    });
    return masters.map((m) => m.tenant_id);
  }

  /**
   * Ids dos admins de plataforma com escopo total. Uma linha de auditoria
   * assinada por um deles denuncia o master ao admin restrito tanto quanto o
   * uuid do tenant — daí a lista, no mesmo estilo de protectedTenantIds().
   */
  private async protectedAdminIds(): Promise<string[]> {
    const masters = await this.prisma.user.findMany({
      where: { ativo: true, is_platform_admin: true, platform_scopes: { has: '*' } },
      select: { id: true },
    });
    return masters.map((m) => m.id);
  }

  /**
   * Escopo total ('*') lido do banco, não do JWT — revogar tem efeito imediato,
   * igual ao PlatformAdminGuard.
   */
  private async hasFullScope(admin: AuthUser): Promise<boolean> {
    const caller = await this.prisma.user.findUnique({
      where: { id: admin.id },
      select: { platform_scopes: true },
    });
    return !!caller?.platform_scopes?.includes('*');
  }

  /**
   * Barra admin sem escopo total de agir sobre o tenant do admin master — nem
   * sobre o tenant em si, nem sobre os usuários dele. É o que impede o restrito
   * de banir, excluir ou impersonar o próprio master.
   */
  async assertTenantAllowed(admin: AuthUser, tenantId: string | null | undefined): Promise<void> {
    if (!tenantId) return;
    if (await this.hasFullScope(admin)) return;
    if (await this.isProtectedTenant(tenantId)) {
      throw new ForbiddenException('Tenant protegido');
    }
  }

  // ---- Visão geral ----------------------------------------------------------
  async stats() {
    const [tenants, users, leads, messages, instances, activeInstances] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.user.count(),
      this.prisma.lead.count(),
      this.estimatedMessageCount(),
      this.prisma.whatsappInstance.count(),
      this.prisma.whatsappInstance.count({ where: { status: { in: ['open', 'connected', 'connecting'] } } }),
    ]);
    return { tenants, users, leads, messages, instances, active_instances: activeInstances };
  }

  // ---- Tenants --------------------------------------------------------------
  /**
   * O admin restrito não deve nem saber que o tenant do master existe: em vez
   * de 403 na abertura, ele some da listagem. Os ids protegidos saem numa
   * consulta só (nada de checar tenant a tenant — seria N+1).
   */
  async listTenants(admin: AuthUser) {
    const full = await this.hasFullScope(admin);
    const [tenants, activeByTenant, protectedIds] = await Promise.all([
      this.prisma.tenant.findMany({
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          nome: true,
          pool_enabled: true,
          created_at: true,
          owner: { select: { id: true, nome: true, email: true } },
          _count: { select: { users: true, leads: true, instances: true } },
          billing_value: true,
          billing_cycle_months: true,
          billing_paid_until: true,
          suspended_at: true,
        },
      }),
      this.prisma.whatsappInstance.groupBy({
        by: ['tenant_id'],
        where: { status: { in: ['open', 'connected', 'connecting'] } },
        _count: { id: true },
      }),
      full ? Promise.resolve<string[]>([]) : this.protectedTenantIds(),
    ]);
    const activeMap = new Map(activeByTenant.map((a) => [a.tenant_id, a._count.id]));
    const hidden = new Set(protectedIds);
    return tenants.filter((t) => !hidden.has(t.id)).map((t) => ({
      id: t.id,
      nome: t.nome,
      pool_enabled: t.pool_enabled,
      created_at: t.created_at,
      owner: t.owner,
      users: t._count.users,
      leads: t._count.leads,
      instances: t._count.instances,
      active_instances: activeMap.get(t.id) ?? 0,
      billing_value: t.billing_value,
      billing_cycle_months: t.billing_cycle_months,
      billing_paid_until: t.billing_paid_until,
      suspended: !!t.suspended_at,
      billing: deriveBillingStatus(t),
    }));
  }

  async getTenant(admin: AuthUser, id: string) {
    await this.assertTenantAllowed(admin, id);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        nome: true,
        pool_enabled: true,
        prefix_enabled: true,
        created_at: true,
        billing_value: true,
        billing_cycle_months: true,
        billing_paid_until: true,
        suspended_at: true,
        owner: { select: { id: true, nome: true, email: true } },
        users: {
          select: { id: true, nome: true, email: true, role: true, ativo: true, is_platform_admin: true, created_at: true },
          orderBy: { created_at: 'asc' },
        },
        instances: {
          select: { id: true, nome: true, status: true, telefone: true, updated_at: true },
        },
      },
    });
    if (!tenant) throw new NotFoundException('Tenant não encontrado');
    const [leads, messages] = await Promise.all([
      this.prisma.lead.count({ where: { tenant_id: id } }),
      this.prisma.message.count({ where: { tenant_id: id } }),
    ]);
    return { ...tenant, counts: { leads, messages, users: tenant.users.length } };
  }

  // ---- Logs -----------------------------------------------------------------
  /**
   * Os logs são a porta dos fundos do painel: uma linha de auditoria assinada
   * pelo master, ou um erro carimbado com o uuid do tenant dele, entrega o que
   * listTenants/listAnnouncements escondem. Para quem não tem escopo total,
   * essas linhas somem.
   *
   * Filtro no WHERE, nunca em memória — peneirar depois encolheria os take
   * (50/50/30/30) e o restrito veria menos log do que tem direito.
   *
   * Em SQL `col NOT IN (...)` é NULL quando a coluna é NULL, e NULL não passa
   * no WHERE: um `notIn` seco em target_tenant_id/tenant_id sumiria com as
   * linhas sem tenant. Daí o OR explícito, igual ao listAnnouncements.
   * `admin_user_id` e `ApiRequestLog.tenant_id` são NOT NULL no schema, então
   * ali o notIn direto basta.
   */
  async logs(admin: AuthUser) {
    const full = await this.hasFullScope(admin);
    const [hiddenAdmins, hiddenTenants] = full
      ? [[] as string[], [] as string[]]
      : await Promise.all([this.protectedAdminIds(), this.protectedTenantIds()]);

    const auditGuard = {
      ...(hiddenAdmins.length ? { admin_user_id: { notIn: hiddenAdmins } } : {}),
      ...(hiddenTenants.length
        ? { OR: [{ target_tenant_id: null }, { target_tenant_id: { notIn: hiddenTenants } }] }
        : {}),
    };
    const webhookGuard = hiddenTenants.length
      ? { OR: [{ tenant_id: null }, { tenant_id: { notIn: hiddenTenants } }] }
      : {};
    const apiGuard = hiddenTenants.length ? { tenant_id: { notIn: hiddenTenants } } : {};

    const [adminAudit, loginAttempts, webhookErrors, apiUsage] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where: { action: { notIn: ['login_success', 'login_failed'] }, ...auditGuard },
        orderBy: { created_at: 'desc' }, take: 50,
      }),
      this.prisma.adminAuditLog.findMany({
        where: { action: { in: ['login_success', 'login_failed'] }, ...auditGuard },
        orderBy: { created_at: 'desc' }, take: 50,
      }),
      this.prisma.webhookLog.findMany({
        where: { error: { not: null }, ...webhookGuard },
        orderBy: { created_at: 'desc' },
        take: 30,
        select: { id: true, event: true, error: true, tenant_id: true, created_at: true },
      }),
      this.prisma.apiRequestLog.findMany({
        where: { status_code: { gte: 400 }, ...apiGuard },
        orderBy: { created_at: 'desc' },
        take: 30,
        select: { id: true, tenant_id: true, method: true, path: true, status_code: true, created_at: true },
      }),
    ]);
    return { admin_audit: adminAudit, login_attempts: loginAttempts, webhook_errors: webhookErrors, api_errors: apiUsage };
  }

  // ---- Saúde da operação ----------------------------------------------------
  async health() {
    const now = Date.now();
    const since24 = new Date(now - 24 * 60 * 60 * 1000);
    const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [leads, messages, mediaAgg, msgs24, leads24, whTotal24, whErr24, failedLogins24] = await Promise.all([
      this.prisma.lead.count(),
      this.estimatedMessageCount(),
      this.prisma.message.aggregate({ _sum: { media_size_bytes: true }, where: { media_archived: false } }),
      this.prisma.message.count({ where: { created_at: { gte: since24 } } }),
      this.prisma.lead.count({ where: { created_at: { gte: since24 } } }),
      this.prisma.webhookLog.count({ where: { created_at: { gte: since24 } } }),
      this.prisma.webhookLog.count({ where: { created_at: { gte: since24 }, error: { not: null } } }),
      this.prisma.adminAuditLog.count({ where: { action: 'login_failed', created_at: { gte: since24 } } }),
    ]);

    const mediaBytes = Number(mediaAgg._sum.media_size_bytes ?? 0);
    const webhookErrRate = whTotal24 > 0 ? whErr24 / whTotal24 : 0;
    const STORAGE_LIMIT_GB = 8; // Supabase Free=1GB, Pro=8GB — ajuste conforme o plano
    const storageUsedGb = mediaBytes / 1e9;

    const tips: { level: string; text: string }[] = [];
    if (storageUsedGb > STORAGE_LIMIT_GB * 0.8) {
      tips.push({ level: 'warning', text: `Storage de mídia em ${storageUsedGb.toFixed(2)}GB (limite ~${STORAGE_LIMIT_GB}GB). Auto-cleanup roda em 30 dias; considere reduzir retenção ou subir o plano Supabase.` });
    }
    if (webhookErrRate > 0.05) {
      tips.push({ level: 'warning', text: `Taxa de erro de webhook em ${(webhookErrRate * 100).toFixed(1)}% (24h). Verifique conexão das instâncias UazAPI.` });
    }
    if (failedLogins24 > 20) {
      tips.push({ level: 'warning', text: `${failedLogins24} logins falhos em 24h — possível brute-force. Considere bloquear IPs reincidentes.` });
    }
    if (messages > 500_000) {
      tips.push({ level: 'info', text: 'Tabela Message grande. Considere particionamento/arquivamento e índice em (tenant_id, created_at).' });
    }
    tips.push({ level: 'info', text: 'Escala saudável: mídia em CDN/Storage com signed URLs (ok), filas BullMQ com concurrency ajustável, e Redis gerenciado. Monitore via Uptime Kuma (porta 3002).' });
    tips.push({ level: 'info', text: 'Backup: Supabase Pro tem PITR. Garanta backup diário e teste restore. Suba réplica do backend (2+ containers) com o rate-limit já no Redis.' });

    return {
      db: { leads, messages, leads_24h: leads24, messages_24h: msgs24 },
      storage: { media_bytes: mediaBytes, media_gb: Number(storageUsedGb.toFixed(3)), limit_gb: STORAGE_LIMIT_GB, used_pct: Number(((storageUsedGb / STORAGE_LIMIT_GB) * 100).toFixed(1)) },
      webhooks_24h: { total: whTotal24, errors: whErr24, error_rate: Number((webhookErrRate * 100).toFixed(1)) },
      security_24h: { failed_logins: failedLogins24 },
      tips,
    };
  }

  /**
   * Saúde das instâncias para o painel: o que o cron do InstanceHealthService
   * já escreveu (`status`, `ultimo_check`) somado ao alerta em aberto.
   *
   * Tenant suspenso fica de fora — é a mesma regra do monitor: quem está
   * suspenso não é checado, então mostrar a instância dele como "caída" só
   * geraria ruído. O filtro de tenant protegido acompanha `logs`/`listTenants`:
   * o admin restrito não descobre o tenant do master nem pela lista de
   * instâncias.
   */
  async instancesHealth(admin: AuthUser): Promise<{ instancias: InstanceHealthRow[] }> {
    const full = await this.hasFullScope(admin);
    const hiddenTenants = full ? [] : await this.protectedTenantIds();

    const rows = await this.prisma.whatsappInstance.findMany({
      where: {
        tenant: { suspended_at: null },
        ...(hiddenTenants.length ? { tenant_id: { notIn: hiddenTenants } } : {}),
      },
      select: {
        nome: true,
        status: true,
        ultimo_check: true,
        config: true,
        tenant: { select: { nome: true } },
        alerts: {
          where: { resolvido_em: null },
          select: { aberto_em: true },
          orderBy: { aberto_em: 'asc' },
          take: 1,
        },
      },
      orderBy: [{ tenant: { nome: 'asc' } }, { nome: 'asc' }],
    });

    const instancias: InstanceHealthRow[] = rows.map((r) => ({
      tenant: r.tenant.nome,
      nome: r.nome,
      provider: providerDaConfig(r.config),
      status: r.status,
      ultimo_check: r.ultimo_check ? r.ultimo_check.toISOString() : null,
      caida_desde: r.alerts[0] ? r.alerts[0].aberto_em.toISOString() : null,
    }));

    // Caídas no topo, a mais antiga primeiro (ISO compara igual a cronologia);
    // o resto segue tenant/nome, a mesma ordem que veio do banco.
    instancias.sort((a, b) => {
      if (a.caida_desde && b.caida_desde) return a.caida_desde.localeCompare(b.caida_desde);
      if (a.caida_desde) return -1;
      if (b.caida_desde) return 1;
      return a.tenant.localeCompare(b.tenant) || a.nome.localeCompare(b.nome);
    });

    return { instancias };
  }

  // ---- Ações em usuários/tenants --------------------------------------------
  async setUserBanned(admin: AuthUser, userId: string, banned: boolean) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, tenant_id: true, email: true } });
    if (!u) throw new NotFoundException('Usuário não encontrado');
    await this.assertTenantAllowed(admin, u.tenant_id);
    await this.prisma.user.update({ where: { id: userId }, data: { ativo: !banned } });
    await this.prisma.adminAuditLog.create({
      data: { admin_user_id: admin.id, action: banned ? 'user_ban' : 'user_unban', target_tenant_id: u.tenant_id, target_user_id: userId, detail: { email: u.email } },
    });
    return { ok: true };
  }

  async deleteUser(admin: AuthUser, userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenant_id: true, email: true, owned_tenants: { select: { id: true } } },
    });
    if (!u) throw new NotFoundException('Usuário não encontrado');
    await this.assertTenantAllowed(admin, u.tenant_id);
    if (u.owned_tenants.length > 0) {
      throw new ConflictException('Usuário é owner de um workspace — não pode ser excluído. Bana em vez disso.');
    }
    // Desvincula referências que bloqueiam o delete (leads/mensagens ficam, sem responsável).
    await this.prisma.$transaction([
      // Devolução automática, com a MESMA forma do returnToPool: carimbo pra
      // entrar na nuvem, `is_private: false` pra ela ser visível de fato (lead
      // privado de um gerente apagado ficaria carimbado e ainda assim
      // invisível pra todo mundo) e `assumed_at: null` pra quem pegar depois
      // não herdar o corte de histórico do dono que não existe mais.
      this.prisma.lead.updateMany({
        where: { responsavel_id: userId },
        data: {
          responsavel_id: null,
          assumed_at: null,
          is_private: false,
          returned_at: new Date(),
        },
      }),
      this.prisma.message.updateMany({ where: { sent_by_user_id: userId }, data: { sent_by_user_id: null } }),
      this.prisma.message.updateMany({ where: { visible_to_user_id: userId }, data: { visible_to_user_id: null } }),
    ]);
    await this.prisma.user.delete({ where: { id: userId } });
    await this.prisma.adminAuditLog.create({
      data: { admin_user_id: admin.id, action: 'user_delete', target_tenant_id: u.tenant_id, target_user_id: userId, detail: { email: u.email } },
    });
    return { ok: true };
  }

  /**
   * Exclusão TOTAL de um cliente (tenant): apaga todos os dados vinculados e o
   * próprio tenant. Irreversível.
   *
   * O banco tem ciclo de FK não-cascateável (Tenant.owner_id → User Restrict e
   * User.tenant_id → Tenant Restrict, ambos NOT NULL). Quebramos repontando
   * temporariamente owner_id para o admin que executa a ação (FK só exige que o
   * User exista — não precisa ser do mesmo tenant), aí os usuários do tenant
   * podem ser removidos. Tudo numa transação para ser atômico.
   */
  async deleteTenant(admin: AuthUser, tenantId: string) {
    await this.assertTenantAllowed(admin, tenantId);
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        nome: true,
        users: { select: { id: true, is_platform_admin: true } },
        _count: { select: { users: true, leads: true, messages: true, instances: true } },
      },
    });
    if (!t) throw new NotFoundException('Tenant não encontrado');
    if (t.users.some((u) => u.is_platform_admin)) {
      throw new ConflictException('Cliente contém um admin de plataforma — não pode ser excluído.');
    }

    const where = { tenant_id: tenantId };
    await this.prisma.$transaction([
      // Filhos primeiro (ordem FK-safe). Tabelas com onDelete: Cascade a partir
      // destas são removidas junto (WebhookDelivery, BroadcastTarget, QueuePointer).
      this.prisma.leadTag.deleteMany({ where }),
      this.prisma.leadActivity.deleteMany({ where }),
      this.prisma.message.deleteMany({ where }),
      this.prisma.task.deleteMany({ where }),
      this.prisma.notification.deleteMany({ where }),
      this.prisma.lead.deleteMany({ where }),
      this.prisma.instanceLog.deleteMany({ where }),
      this.prisma.instanceHidden.deleteMany({ where }),
      this.prisma.userInstance.deleteMany({ where }),
      this.prisma.whatsappInstance.deleteMany({ where }),
      this.prisma.stage.deleteMany({ where }),
      this.prisma.pipeline.deleteMany({ where }),
      this.prisma.tag.deleteMany({ where }),
      this.prisma.quickReply.deleteMany({ where }),
      this.prisma.pushSubscription.deleteMany({ where }),
      this.prisma.outboundWebhook.deleteMany({ where }),
      this.prisma.apiKey.deleteMany({ where }),
      this.prisma.webhookLog.deleteMany({ where }),
      this.prisma.broadcast.deleteMany({ where }),
      this.prisma.assignmentLog.deleteMany({ where }),
      this.prisma.apiRequestLog.deleteMany({ where }),
      this.prisma.aiUsageLog.deleteMany({ where }),
      // Quebra o ciclo: owner_id passa a apontar pro admin executor.
      this.prisma.tenant.update({ where: { id: tenantId }, data: { owner_id: admin.id } }),
      // Usuários antes dos setores (User.sector_id é Restrict).
      this.prisma.user.deleteMany({ where }),
      this.prisma.sector.deleteMany({ where }),
      this.prisma.tenant.delete({ where: { id: tenantId } }),
    ]);

    await this.prisma.adminAuditLog.create({
      data: {
        admin_user_id: admin.id,
        action: 'tenant_delete',
        target_tenant_id: tenantId,
        detail: { nome: t.nome, counts: t._count },
      },
    });
    this.logger.warn(`TENANT DELETE admin=${admin.email} → tenant=${t.nome} (${tenantId})`);
    return { ok: true };
  }

  async setTenantSuspended(admin: AuthUser, tenantId: string, suspended: boolean) {
    await this.assertTenantAllowed(admin, tenantId);
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, nome: true } });
    if (!t) throw new NotFoundException('Tenant não encontrado');
    const res = await this.prisma.user.updateMany({ where: { tenant_id: tenantId }, data: { ativo: !suspended } });
    // Marca explícita da suspensão: desativar usuários só barra o login, e o
    // WhatsApp segue recebendo/enviando sozinho. `suspended_at` é o que o
    // inbound e o processor de envio leem para parar de trabalhar.
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { suspended_at: suspended ? new Date() : null },
    });
    await this.prisma.adminAuditLog.create({
      data: { admin_user_id: admin.id, action: suspended ? 'tenant_suspend' : 'tenant_unsuspend', target_tenant_id: tenantId, detail: { nome: t.nome, users: res.count } },
    });
    return { ok: true, users_affected: res.count };
  }

  // ---- Cobrança manual ------------------------------------------------------
  /**
   * Patch parcial: campo ausente no body fica como está, campo `null` LIMPA a
   * coluna. Por isso o teste é `!== undefined` e não truthiness — `billing_value:
   * 0` e `billing_paid_until: null` são valores legítimos que precisam gravar.
   */
  async setTenantBilling(admin: AuthUser, tenantId: string, body: unknown) {
    await this.assertTenantAllowed(admin, tenantId);
    const d = billingSchema.parse(body);
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, nome: true } });
    if (!t) throw new NotFoundException('Tenant não encontrado');
    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(d.billing_value !== undefined ? { billing_value: d.billing_value } : {}),
        ...(d.billing_cycle_months !== undefined ? { billing_cycle_months: d.billing_cycle_months } : {}),
        ...(d.billing_paid_until !== undefined
          ? { billing_paid_until: d.billing_paid_until ? anchorPaidUntil(d.billing_paid_until) : null }
          : {}),
      },
      select: { billing_value: true, billing_cycle_months: true, billing_paid_until: true },
    });
    // Loga o ESTADO SALVO, não o body: depois do re-anchor (e de um patch
    // parcial) o input não descreve mais a coluna, e a auditoria existe pra
    // responder "o que ficou gravado". Datas viram ISO na mão — `detail` é Json.
    await this.prisma.adminAuditLog.create({
      data: {
        admin_user_id: admin.id,
        action: 'tenant_billing_update',
        target_tenant_id: tenantId,
        detail: {
          nome: t.nome,
          billing_value: updated.billing_value,
          billing_cycle_months: updated.billing_cycle_months,
          billing_paid_until: updated.billing_paid_until ? updated.billing_paid_until.toISOString() : null,
        },
      },
    });
    return { ok: true, ...updated };
  }

  /**
   * Registra um pagamento: empurra `billing_paid_until` um ciclo à frente a
   * partir de MAX(vencimento atual, hoje). Quem está atrasado não ganha crédito
   * retroativo (o mês em atraso não é "coberto" pelo pagamento de agora), e quem
   * paga adiantado acumula a partir do vencimento futuro.
   *
   * "Hoje" é o dia calendário de SÃO PAULO, não o dia UTC: das 21h à meia-noite
   * o relógio UTC já virou, e o cliente que pagasse às 23h ganharia um dia a
   * mais de graça (e o vencimento cairia num dia diferente do que a listagem
   * mostra, que usa o mesmo `dayInTz`).
   *
   * O write é CONDICIONAL ao `billing_paid_until` lido: dois cliques no botão
   * (ou duas abas) avançariam dois ciclos com um `update` seco.
   */
  async markTenantPaid(admin: AuthUser, tenantId: string, now: Date = new Date()) {
    await this.assertTenantAllowed(admin, tenantId);
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, nome: true, billing_value: true, billing_cycle_months: true, billing_paid_until: true },
    });
    if (!t) throw new NotFoundException('Tenant não encontrado');
    if (!t.billing_cycle_months || !t.billing_value || t.billing_value <= 0) {
      throw new BadRequestException('Cobrança não configurada — defina valor e ciclo antes.');
    }
    const hoje = new Date(dayInTz(now, BILLING_TZ) + NOON_MS);
    const base = t.billing_paid_until && t.billing_paid_until > hoje ? t.billing_paid_until : hoje;
    // addCycleMonths devolve sempre ancorado ao meio-dia UTC.
    const paidUntil = addCycleMonths(base, t.billing_cycle_months);
    const res = await this.prisma.tenant.updateMany({
      where: { id: tenantId, billing_paid_until: t.billing_paid_until },
      data: { billing_paid_until: paidUntil },
    });
    if (res.count === 0) {
      throw new ConflictException('Pagamento já registrado — recarregue');
    }
    await this.prisma.adminAuditLog.create({
      data: {
        admin_user_id: admin.id,
        action: 'tenant_mark_paid',
        target_tenant_id: tenantId,
        detail: { nome: t.nome, valor: t.billing_value, paid_until: paidUntil.toISOString() },
      },
    });
    return { ok: true, paid_until: paidUntil.toISOString() };
  }

  /**
   * KPIs de receita em CENTAVOS, tudo normalizado para o equivalente MENSAL —
   * um anual de R$1.200 pesa R$100/mês, senão o total oscilaria conforme o ciclo
   * de cada cliente. O tenant do master fica de fora para o admin restrito, pela
   * mesma razão de `listTenants`: o valor do resumo denunciaria a existência
   * dele.
   */
  async billingSummary(admin: AuthUser, now: Date = new Date()) {
    const full = await this.hasFullScope(admin);
    const hidden = new Set(full ? [] : await this.protectedTenantIds());
    const tenants = (
      await this.prisma.tenant.findMany({
        select: { id: true, billing_value: true, billing_cycle_months: true, billing_paid_until: true, suspended_at: true },
      })
    ).filter((t) => !hidden.has(t.id));
    const acc = {
      receita_mensal_esperada: 0,
      em_dia: { qtde: 0, valor_mensal: 0 },
      vence_em_breve: { qtde: 0, valor_mensal: 0 },
      vencidos: { qtde: 0, valor_mensal: 0 },
      suspensos: 0,
    };
    for (const t of tenants) {
      if (t.suspended_at) acc.suspensos++;
      const { status } = deriveBillingStatus(t, now);
      // 'sem_cobranca' já garante valor > 0 e ciclo válido nos que passam daqui;
      // os `??` só existem para não precisar de cast.
      if (status === 'sem_cobranca') continue;
      const mensal = monthlyCents(t.billing_value ?? 0, t.billing_cycle_months ?? 1);
      acc.receita_mensal_esperada += mensal;
      const bucket = status === 'em_dia' ? acc.em_dia : status === 'vence_em_breve' ? acc.vence_em_breve : acc.vencidos;
      bucket.qtde++;
      bucket.valor_mensal += mensal;
    }
    return acc;
  }

  // ---- Impersonação ---------------------------------------------------------
  async impersonate(admin: AuthUser, targetUserId: string, ip?: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, nome: true, email: true, role: true, tenant_id: true, ativo: true },
    });
    if (!target) throw new NotFoundException('Usuário alvo não encontrado');
    await this.assertTenantAllowed(admin, target.tenant_id);

    const payload = {
      sub: target.id,
      email: target.email,
      role: target.role,
      tenantId: target.tenant_id,
      impersonatedBy: admin.id,
    };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRY', '1h'),
    });

    await this.prisma.adminAuditLog.create({
      data: {
        admin_user_id: admin.id,
        action: 'impersonate',
        target_tenant_id: target.tenant_id,
        target_user_id: target.id,
        detail: { email: target.email },
        ip: ip ?? null,
      },
    });
    this.logger.warn(`IMPERSONATE admin=${admin.email} → user=${target.email}`);

    return {
      accessToken,
      user: {
        id: target.id,
        nome: target.nome,
        email: target.email,
        role: target.role,
        tenantId: target.tenant_id,
      },
    };
  }

  // ---- Anúncios -------------------------------------------------------------
  async createAnnouncement(admin: AuthUser, body: unknown) {
    const d = announcementSchema.parse(body);
    await this.assertTenantAllowed(admin, d.target_tenant_id);
    const created = await this.prisma.announcement.create({
      data: {
        title: d.title,
        body: d.body,
        level: d.level,
        target_tenant_id: d.target_tenant_id ?? null,
        expires_at: d.expires_at ? new Date(d.expires_at) : null,
        created_by: admin.id,
      },
    });
    await this.prisma.adminAuditLog.create({
      data: { admin_user_id: admin.id, action: 'announcement_create', detail: { id: created.id, level: d.level } },
    });
    return created;
  }

  /**
   * O admin restrito não pode nem SABER que o tenant do master existe, e um
   * aviso direcionado carrega o uuid dele em `target_tenant_id`. Filtramos no
   * banco, não em memória, para o `take: 100` não encolher.
   *
   * `notIn` sozinho descartaria os avisos globais: em SQL, `col NOT IN (...)` é
   * NULL quando a coluna é NULL, e NULL não passa no WHERE. Daí o OR explícito.
   */
  async listAnnouncements(admin: AuthUser) {
    const full = await this.hasFullScope(admin);
    const hidden = full ? [] : await this.protectedTenantIds();
    return this.prisma.announcement.findMany({
      where: hidden.length
        ? { OR: [{ target_tenant_id: null }, { target_tenant_id: { notIn: hidden } }] }
        : {},
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  async setAnnouncementActive(admin: AuthUser, id: string, active: boolean) {
    const ann = await this.prisma.announcement.findUnique({
      where: { id },
      select: { target_tenant_id: true },
    });
    if (!ann) throw new NotFoundException('Aviso não encontrado');
    await this.assertTenantAllowed(admin, ann.target_tenant_id);
    return this.prisma.announcement.update({ where: { id }, data: { active } });
  }

  /** Anúncios ativos visíveis para um usuário (todos ou do tenant dele). */
  async activeFor(user: AuthUser) {
    const now = new Date();
    return this.prisma.announcement.findMany({
      where: {
        active: true,
        OR: [{ target_tenant_id: null }, { target_tenant_id: user.tenantId }],
        AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: now } }] }],
      },
      orderBy: { created_at: 'desc' },
      select: { id: true, title: true, body: true, level: true, created_at: true },
    });
  }
}
