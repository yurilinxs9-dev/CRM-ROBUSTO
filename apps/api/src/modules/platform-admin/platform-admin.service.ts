import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        nome: true,
        pool_enabled: true,
        created_at: true,
        owner: { select: { id: true, nome: true, email: true } },
        _count: { select: { users: true, leads: true, instances: true } },
      },
    });
    return tenants.map((t) => ({
      id: t.id,
      nome: t.nome,
      pool_enabled: t.pool_enabled,
      created_at: t.created_at,
      owner: t.owner,
      users: t._count.users,
      leads: t._count.leads,
      instances: t._count.instances,
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
    const [adminAudit, webhookErrors, apiUsage] = await Promise.all([
      this.prisma.adminAuditLog.findMany({ orderBy: { created_at: 'desc' }, take: 50 }),
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
    return { admin_audit: adminAudit, webhook_errors: webhookErrors, api_errors: apiUsage };
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
