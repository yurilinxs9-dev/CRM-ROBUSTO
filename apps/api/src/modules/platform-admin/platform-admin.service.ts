import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

const announcementSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  level: z.enum(['INFO', 'WARNING', 'MAINTENANCE']).optional().default('INFO'),
  target_tenant_id: z.string().uuid().optional().nullable(),
  expires_at: z.string().datetime().optional().nullable(),
});

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ---- Visão geral ----------------------------------------------------------
  async stats() {
    const [tenants, users, leads, messages, instances, activeInstances] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.user.count(),
      this.prisma.lead.count(),
      this.prisma.message.count(),
      this.prisma.whatsappInstance.count(),
      this.prisma.whatsappInstance.count({ where: { status: { in: ['open', 'connected', 'connecting'] } } }),
    ]);
    return { tenants, users, leads, messages, instances, active_instances: activeInstances };
  }

  // ---- Tenants --------------------------------------------------------------
  async listTenants() {
    const [tenants, activeByTenant] = await Promise.all([
      this.prisma.tenant.findMany({
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          nome: true,
          pool_enabled: true,
          created_at: true,
          owner: { select: { id: true, nome: true, email: true } },
          _count: { select: { users: true, leads: true, instances: true } },
        },
      }),
      this.prisma.whatsappInstance.groupBy({
        by: ['tenant_id'],
        where: { status: { in: ['open', 'connected', 'connecting'] } },
        _count: { id: true },
      }),
    ]);
    const activeMap = new Map(activeByTenant.map((a) => [a.tenant_id, a._count.id]));
    return tenants.map((t) => ({
      id: t.id,
      nome: t.nome,
      pool_enabled: t.pool_enabled,
      created_at: t.created_at,
      owner: t.owner,
      users: t._count.users,
      leads: t._count.leads,
      instances: t._count.instances,
      active_instances: activeMap.get(t.id) ?? 0,
    }));
  }

  async getTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        nome: true,
        pool_enabled: true,
        prefix_enabled: true,
        created_at: true,
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
  async logs() {
    const [adminAudit, loginAttempts, webhookErrors, apiUsage] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where: { action: { notIn: ['login_success', 'login_failed'] } },
        orderBy: { created_at: 'desc' }, take: 50,
      }),
      this.prisma.adminAuditLog.findMany({
        where: { action: { in: ['login_success', 'login_failed'] } },
        orderBy: { created_at: 'desc' }, take: 50,
      }),
      this.prisma.webhookLog.findMany({
        where: { error: { not: null } },
        orderBy: { created_at: 'desc' },
        take: 30,
        select: { id: true, event: true, error: true, tenant_id: true, created_at: true },
      }),
      this.prisma.apiRequestLog.findMany({
        where: { status_code: { gte: 400 } },
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
      this.prisma.message.count(),
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

  // ---- Ações em usuários/tenants --------------------------------------------
  async setUserBanned(admin: AuthUser, userId: string, banned: boolean) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, tenant_id: true, email: true } });
    if (!u) throw new NotFoundException('Usuário não encontrado');
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
    if (u.owned_tenants.length > 0) {
      throw new ConflictException('Usuário é owner de um workspace — não pode ser excluído. Bana em vez disso.');
    }
    // Desvincula referências que bloqueiam o delete (leads/mensagens ficam, sem responsável).
    await this.prisma.$transaction([
      this.prisma.lead.updateMany({ where: { responsavel_id: userId }, data: { responsavel_id: null } }),
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
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, nome: true } });
    if (!t) throw new NotFoundException('Tenant não encontrado');
    const res = await this.prisma.user.updateMany({ where: { tenant_id: tenantId }, data: { ativo: !suspended } });
    await this.prisma.adminAuditLog.create({
      data: { admin_user_id: admin.id, action: suspended ? 'tenant_suspend' : 'tenant_unsuspend', target_tenant_id: tenantId, detail: { nome: t.nome, users: res.count } },
    });
    return { ok: true, users_affected: res.count };
  }

  // ---- Impersonação ---------------------------------------------------------
  async impersonate(admin: AuthUser, targetUserId: string, ip?: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, nome: true, email: true, role: true, tenant_id: true, ativo: true },
    });
    if (!target) throw new NotFoundException('Usuário alvo não encontrado');

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

  listAnnouncements() {
    return this.prisma.announcement.findMany({ orderBy: { created_at: 'desc' }, take: 100 });
  }

  async setAnnouncementActive(id: string, active: boolean) {
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
