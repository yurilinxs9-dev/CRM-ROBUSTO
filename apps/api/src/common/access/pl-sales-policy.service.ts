import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../types/auth-user';
import { isPlSalesOnly } from './pl-sales-access';
import { PL_PIPELINE } from '../../modules/pl-sales/pl-sales.domain';

export interface AccessRequest {
  user: AuthUser;
  method: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READS = new Set([
  '/auth/me', '/users/list', '/users/me', '/notifications', '/announcements/active',
  '/pipelines', '/tags', '/sectors', '/lead-views', '/custom-fields', '/custom-fields/schema',
  '/quick-replies', '/instances', '/push/vapid-public-key',
  // These services enforce own-row scopes; never extend this to a prefix match.
  '/leads', '/leads/export', '/tasks', '/tasks/today', '/tasks/upcoming', '/tasks/overdue', '/tasks/export',
  '/pl-sales', '/pl-sales/candidates',
]);
const LEAD_READS = new Set(['', 'messages', 'activities', 'timeline', 'media', 'contacts', 'insight', 'lembretes']);
const LEAD_FIELDS = new Set([
  'nome', 'telefone', 'email', 'temperatura', 'valor_estimado', 'empresa', 'cargo', 'tags', 'dados_custom',
  'responsavel_id', 'pipeline_id', 'estagio_id',
]);

/** Match the full URL, including method. Ambiguous encodings fail closed. */
export function accessPath(request: Pick<AccessRequest, 'originalUrl' | 'url' | 'path'>): string {
  const raw = (request.originalUrl ?? request.url ?? request.path ?? '').split('?')[0];
  if (/%(?:2f|5c)/i.test(raw)) throw new ForbiddenException();
  let path: string;
  try { path = decodeURIComponent(raw).toLowerCase(); } catch { throw new ForbiddenException(); }
  if (!path.startsWith('/') || /[%\\]/.test(path) || path.includes('//') || path.split('/').some(p => p === '.' || p === '..')) {
    throw new ForbiddenException();
  }
  return path.replace(/^\/api(?=\/|$)/, '').replace(/\/$/, '') || '/';
}

@Injectable()
export class PlSalesPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  private deny(): never { throw new ForbiddenException('Perfil restrito à carteira e vendas próprias'); }

  private id(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) return this.deny();
    return value;
  }

  private async ownedLead(id: unknown, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: this.id(id), tenant_id: user.tenantId, responsavel_id: user.id },
      select: { id: true, pipeline_id: true },
    });
    if (!lead) return this.deny();
    return lead;
  }

  private async stage(id: unknown, pipelineId: string, user: AuthUser) {
    const stage = await this.prisma.stage.findFirst({
      where: { id: this.id(id), tenant_id: user.tenantId, pipeline_id: pipelineId, OR: [{ user_id: null }, { user_id: user.id }] },
      select: { id: true },
    });
    if (!stage) this.deny();
  }

  private async leadFields(body: Record<string, unknown>, user: AuthUser, pipelineId: string, creating = false) {
    for (const key of Object.keys(body)) {
      if (!LEAD_FIELDS.has(key) && !(creating && key === 'instancia_whatsapp')) this.deny();
    }
    if (body.responsavel_id !== undefined && body.responsavel_id !== user.id && !(creating && (body.responsavel_id === '' || body.responsavel_id === null))) this.deny();
    if (body.pipeline_id !== undefined && body.pipeline_id !== pipelineId && !(creating && (body.pipeline_id === '' || body.pipeline_id === null))) this.deny();
    if (body.estagio_id !== undefined && !(creating && (body.estagio_id === '' || body.estagio_id === null))) {
      await this.stage(body.estagio_id, pipelineId, user);
    }
  }

  async assertAllowed(request: AccessRequest): Promise<void> {
    const { user } = request;
    if (!isPlSalesOnly(user)) return;
    const path = accessPath(request);
    const method = request.method.toUpperCase();
    const read = method === 'GET' || method === 'HEAD';
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) this.deny();

    // Validate both locations independently: a safe body must not mask an unsafe query.
    for (const source of [request.query, body]) {
      for (const key of ['lead_id', 'leadId']) {
        if (source && source[key] !== undefined) {
          if (source === body && source[key] === null && path.startsWith('/tasks')) continue;
          await this.ownedLead(source[key], user);
        }
      }
    }

    if (read && READS.has(path)) return;
    if (read && path === `/pipelines/${PL_PIPELINE}`) return;
    if (method === 'PATCH' && ['/users/me', '/users/me/password', '/notifications/read-all'].includes(path)) return;
    if (method === 'POST' && path === '/users/me/avatar') return;
    if (method === 'PATCH' && /^\/notifications\/[^/]+\/read$/.test(path)) {
      this.id(path.split('/')[2]); // Service also scopes notification by user + tenant.
      return;
    }
    if (method === 'PATCH' && path.startsWith('/notifications/read-by-lead/')) {
      await this.ownedLead(path.slice('/notifications/read-by-lead/'.length), user);
      return;
    }
    if ((method === 'POST' && path === '/push/subscribe') || (method === 'DELETE' && path === '/push/unsubscribe')) {
      if (typeof body.endpoint !== 'string' || !body.endpoint) this.deny();
      const subscription = await this.prisma.pushSubscription.findFirst({ where: { endpoint: body.endpoint as string }, select: { user_id: true, tenant_id: true } });
      if (subscription && (subscription.user_id !== user.id || subscription.tenant_id !== user.tenantId)) this.deny();
      return;
    }
    if (method === 'POST' && path === '/pl-sales') {
      await this.ownedLead(body.lead_id, user);
      if (body.seller_id !== user.id) this.deny();
      return; // PlSalesService performs the pipeline + seller + transaction checks.
    }
    if (method === 'POST' && path === '/leads') {
      await this.leadFields(body, user, PL_PIPELINE, true);
      request.body = { ...body, responsavel_id: user.id, pipeline_id: PL_PIPELINE };
      return;
    }
    const bulk = /^\/leads\/bulk\/(move-stage|tag|archive)$/.exec(path);
    if (method === 'POST' && bulk) {
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500) this.deny();
      const ids = [...new Set((body.ids as unknown[]).map(id => this.id(id)))];
      const moving = bulk[1] === 'move-stage';
      if (moving) await this.stage(body.estagio_id, PL_PIPELINE, user);
      const count = await this.prisma.lead.count({ where: {
        id: { in: ids }, tenant_id: user.tenantId, responsavel_id: user.id,
        ...(moving ? { pipeline_id: PL_PIPELINE } : {}),
      } });
      if (count !== ids.length) this.deny();
      return;
    }
    const leadRoute = /^\/leads\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (leadRoute) {
      const child = leadRoute[2] ?? '';
      const allowed = (read && LEAD_READS.has(child)) ||
        (method === 'PATCH' && ['', 'stage', 'mark-read', 'ai-block'].includes(child)) ||
        (method === 'POST' && child === 'sync-profile');
      if (!allowed) this.deny();
      const lead = await this.ownedLead(leadRoute[1], user);
      if (method === 'PATCH' && child === '') await this.leadFields(body, user, lead.pipeline_id);
      if (method === 'PATCH' && child === 'stage') await this.stage(body.estagio_id, lead.pipeline_id, user);
      return;
    }
    // Multipart is parsed AFTER guards. Only these two known routes delegate the
    // body ownership check to MessagesService.resolveLeadAndToken, after parsing.
    if (method === 'POST' && ['/messages/send-audio', '/messages/send-media'].includes(path)) {
      return;
    }
    if (method === 'POST' && ['/messages/send-text', '/messages/send-media-ref', '/messages/internal-note', '/media/upload-url'].includes(path)) {
      await this.ownedLead(body.lead_id, user);
      if (path === '/messages/internal-note' && body.mentioned_user_ids !== undefined) {
        if (!Array.isArray(body.mentioned_user_ids) || body.mentioned_user_ids.some(id => id !== user.id)) this.deny();
      }
      return;
    }
    const history = /^\/messages\/(history|sync-chat)\/([^/]+)$/.exec(path);
    if (history && ((read && history[1] === 'history') || (method === 'POST' && history[1] === 'sync-chat'))) {
      await this.ownedLead(history[2], user);
      return;
    }
    const messageRoute = /^\/messages\/([^/]+)\/(media|resend)$/.exec(path);
    if (messageRoute && ((read && messageRoute[2] === 'media') || (method === 'POST' && messageRoute[2] === 'resend'))) {
      const message = await this.prisma.message.findFirst({
        where: { id: this.id(messageRoute[1]), tenant_id: user.tenantId }, select: { lead_id: true },
      });
      if (!message) this.deny();
      await this.ownedLead(message!.lead_id, user);
      return;
    }
    if (method === 'POST' && path === '/tasks') return;
    const taskRoute = /^\/tasks\/([^/]+)(\/complete)?$/.exec(path);
    if (taskRoute && ((!taskRoute[2] && (read || ['PATCH', 'DELETE'].includes(method))) || (taskRoute[2] && method === 'POST'))) {
      const task = await this.prisma.task.findFirst({
        where: { id: this.id(taskRoute[1]), tenant_id: user.tenantId, responsavel_id: user.id }, select: { lead_id: true },
      });
      if (!task) this.deny();
      if (task!.lead_id) await this.ownedLead(task!.lead_id, user);
      return;
    }
    this.deny();
  }
}
