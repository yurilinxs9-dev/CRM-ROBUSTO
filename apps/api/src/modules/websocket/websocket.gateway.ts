import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isPlSalesOnly, PL_SALES_TENANT_ID } from '../../common/access/pl-sales-access';

// Global legacy broadcasts must not include restricted or pending-auth sockets.
const UNRESTRICTED_ROOM = 'access:unrestricted';
const LEAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rawFrontendUrl = process.env['FRONTEND_URL'] ?? '';
const wsOrigins = rawFrontendUrl
  ? rawFrontendUrl.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:3000'];

@WebSocketGateway({
  cors: { origin: wsOrigins, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 20000,
  pingTimeout: 25000,
})
export class CrmGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(CrmGateway.name);
  private readonly authenticating = new WeakMap<Socket, Promise<void>>();

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  handleConnection(client: Socket): Promise<void> {
    client.data.disconnected = false;
    const pending = this.authenticate(client);
    this.authenticating.set(client, pending);
    return pending.finally(() => this.authenticating.delete(client));
  }

  private async authenticate(client: Socket) {
    try {
      const token = client.handshake.auth?.token ||
                    client.handshake.headers.authorization?.split(' ')[1];
      if (!token) {
        this.logger.warn(`Socket ${client.id} rejeitado — sem token no handshake`);
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify(token, {
        secret: this.config.get('JWT_SECRET'),
      });
      const tenantId = payload.tenantId ?? payload.tenant_id;
      if (typeof payload.sub !== 'string' || !payload.sub || typeof tenantId !== 'string' || !tenantId) {
        client.disconnect();
        return;
      }
      const user = await this.socketUser(payload.sub, tenantId);
      if (client.data.disconnected) return;
      if (!user) {
        client.disconnect();
        return;
      }
      const restricted = isPlSalesOnly({ tenantId: user.tenant_id, role: user.role, plSalesOnly: user.pl_sales_only });
      client.data.userId = user.id;
      client.data.tenantId = tenantId;
      client.data.plSalesOnly = restricted;
      await client.join(`user:${user.id}`);
      if (!restricted) {
        await client.join(UNRESTRICTED_ROOM);
        await client.join(`tenant:${tenantId}`);
      }
      client.data.authenticated = true;
      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub} tenant: ${tenantId})`);
    } catch (err) {
      // Surface handshake errors — sem isso falhas como JWT expirado, secret
      // diferente ou payload mal-formado ficam invisíveis e o cliente parece
      // "conectado" no nível de protocolo mas nunca recebe nada.
      this.logger.warn(
        `Socket ${client.id} rejeitado: ${(err as Error)?.message ?? err}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    client.data.authenticated = false;
    client.data.disconnected = true;
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:lead')
  async handleJoinLead(client: Socket, leadId: string) {
    // Nest subscribes to events before its async connection hook completes.
    await this.authenticating.get(client);
    if (!client.data.authenticated || typeof leadId !== 'string' || !LEAD_ID.test(leadId)) return { ok: false };
    try {
      // Re-read PL identity in case a profile update raced with the handshake.
      if (client.data.tenantId === PL_SALES_TENANT_ID) {
        const user = await this.socketUser(client.data.userId, client.data.tenantId);
        if (!user) { client.disconnect(); return { ok: false }; }
        const restricted = isPlSalesOnly({ tenantId: user.tenant_id, role: user.role, plSalesOnly: user.pl_sales_only });
        if (restricted !== client.data.plSalesOnly) { client.disconnect(); return { ok: false }; }
        if (restricted) {
          const lead = await this.prisma.lead.findFirst({
            where: { id: leadId, tenant_id: user.tenant_id, responsavel_id: user.id },
            select: { id: true },
          });
          // Ack only: membership would retain access after the lead is reassigned.
          return { ok: !!lead };
        }
      }
      await client.join(`lead:${leadId}`);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  @SubscribeMessage('leave:lead')
  handleLeaveLead(client: Socket, leadId: string) {
    if (typeof leadId !== 'string' || !LEAD_ID.test(leadId)) return;
    client.leave(`lead:${leadId}`);
  }

  private toTenant(tenantId: string | undefined) {
    return this.server.to(tenantId ? `tenant:${tenantId}` : UNRESTRICTED_ROOM);
  }

  private async socketUser(id: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenant_id: tenantId, ativo: true },
      select: { id: true, tenant_id: true, role: true, ativo: true, pl_sales_only: true },
    });
    return user && user.ativo && user.tenant_id === tenantId && user.id === id ? user : null;
  }

  /** Socket.IO adapter propagates this to every replica/session of the user. */
  disconnectUser(userId: string): void {
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  private async emitToRestrictedOwner(leadId: string, events: Array<[string, unknown]>, tenantId?: string): Promise<void> {
    if (tenantId && tenantId !== PL_SALES_TENANT_ID) return;
    try {
      // Never cache ownership: reassignment immediately changes the recipient.
      const lead = await this.prisma.lead.findFirst({
        where: { id: leadId, tenant_id: PL_SALES_TENANT_ID },
        select: { responsavel_id: true, responsavel: { select: { id: true, tenant_id: true, role: true, ativo: true, pl_sales_only: true } } },
      });
      const owner = lead?.responsavel;
      if (!owner?.ativo || owner.id !== lead?.responsavel_id || !isPlSalesOnly({ tenantId: owner.tenant_id, role: owner.role, plSalesOnly: owner.pl_sales_only })) return;
      for (const [event, payload] of events) this.server.to(`user:${owner.id}`).emit(event, payload);
    } catch {
      // Existing callers fire-and-forget. Do not turn a DB outage into a global
      // fallback or an unhandled rejection, and do not log private payloads.
      this.logger.warn('Restricted websocket delivery skipped: ownership lookup failed');
    }
  }

  emitLeadStageChanged(leadId: string, data: unknown, tenantId?: string) {
    this.toTenant(tenantId).emit('lead:stage-changed', { leadId, ...(data as object) });
    return this.emitToRestrictedOwner(leadId, [['lead:stage-changed', { leadId, ...(data as object) }]], tenantId);
  }

  /**
   * Lead novo no funil.
   *
   * Faltava: o Kanban só reagia a `lead:stage-changed` e a `lead:new-message`,
   * então lead que nasce SEM mensagem — criado pela API pública (integração de
   * formulário) ou manualmente por um colega — não aparecia na tela de quem
   * estava com o board aberto. Só entrava no poll de 60s ou num F5, e quem
   * estava olhando concluía que a automação não tinha rodado.
   *
   * Manda pipeline e estágio junto para o cliente decidir se aquele board
   * precisa recarregar, em vez de invalidar a lista a cada lead de qualquer
   * funil do tenant.
   */
  emitLeadCreated(
    leadId: string,
    data: { pipeline_id?: string; estagio_id?: string },
    tenantId?: string,
  ) {
    this.toTenant(tenantId).emit('lead:created', { leadId, ...data });
    return this.emitToRestrictedOwner(leadId, [['lead:created', { leadId, ...data }]], tenantId);
  }

  emitNewMessage(leadId: string, message: unknown, tenantId?: string) {
    this.logger.log(
      `emitNewMessage → lead:${leadId} tenant:${tenantId ?? '-'}`,
    );
    this.server.to(`lead:${leadId}`).emit('message:new', message);
    this.toTenant(tenantId).emit('lead:new-message', { leadId, message });
    return this.emitToRestrictedOwner(leadId, [['message:new', message], ['lead:new-message', { leadId, message }]], tenantId);
  }

  emitMessageStatusUpdate(leadId: string, messageId: string, status: string, tenantId?: string) {
    this.server.to(`lead:${leadId}`).emit('message:status-updated', { messageId, status });
    return this.emitToRestrictedOwner(leadId, [['message:status-updated', { messageId, status }]], tenantId);
  }

  /**
   * Emitted when deferred media upload finishes. Frontend patches the message
   * already in cache so the audio/image renders without a refresh.
   */
  emitMessageMediaReady(
    leadId: string,
    payload: { messageId: string; media_url: string; media_mimetype?: string | null },
    tenantId?: string,
  ) {
    this.server.to(`lead:${leadId}`).emit('message:media-ready', payload);
    return this.emitToRestrictedOwner(leadId, [['message:media-ready', payload]], tenantId);
  }

  emitInstanceStatusChanged(instanceName: string, status: string, tenantId?: string) {
    this.toTenant(tenantId).emit('instance:status-changed', { instanceName, status });
  }

  emitQrCode(instanceName: string, qrCode: string, tenantId?: string) {
    this.toTenant(tenantId).emit('instance:qr-code', { instanceName, qrCode });
  }

  emitTaskCreated(responsavelId: string, task: unknown) {
    return this.emitOwnedUserEvent(responsavelId, 'task:created', task, 'task');
  }

  emitTaskUpdated(responsavelId: string, task: unknown) {
    return this.emitOwnedUserEvent(responsavelId, 'task:updated', task, 'task');
  }

  emitTaskOverdue(responsavelId: string, payload: { taskId: string; titulo: string; responsavel_id: string }) {
    return this.emitOwnedUserEvent(responsavelId, 'task:overdue', payload, 'task');
  }

  emitLeadUnreadReset(leadId: string, tenantId?: string) {
    this.toTenant(tenantId).emit('lead:unread-reset', { leadId, mensagens_nao_lidas: 0 });
    return this.emitToRestrictedOwner(leadId, [['lead:unread-reset', { leadId, mensagens_nao_lidas: 0 }]], tenantId);
  }

  /**
   * Toggle do kanban individual (ligar/desligar).
   *
   * É a mutação de Kanban mais larga que existe: reescreve o conjunto de
   * colunas do tenant inteiro e remapeia TODO lead de uma vez. Quem estava com
   * o board aberto seguiria arrastando card para coluna que não existe mais —
   * daí o evento ir para o tenant todo, e não só para quem apertou o botão.
   */
  emitKanbanIndividualChanged(tenantId: string, enabled: boolean) {
    this.toTenant(tenantId).emit('kanban:individual-changed', { kanban_individual: enabled });
  }

  emitLeadUpdated(leadId: string, data: unknown, tenantId?: string) {
    this.toTenant(tenantId).emit('lead:updated', { leadId, ...(data as object) });
    return this.emitToRestrictedOwner(leadId, [['lead:updated', { leadId, ...(data as object) }]], tenantId);
  }

  /** Notificação in-app para um usuário específico (alimenta o sino do Header). */
  emitNotification(userId: string, notification: unknown) {
    return this.emitOwnedUserEvent(userId, 'notification:new', notification, 'notification');
  }

  private async emitOwnedUserEvent(userId: string, event: string, payload: unknown, kind: 'task' | 'notification'): Promise<void> {
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    // Callers supply database records. A known other tenant keeps its old path.
    const tenantId = typeof data.tenant_id === 'string' ? data.tenant_id : undefined;
    if (tenantId && tenantId !== PL_SALES_TENANT_ID) {
      this.server.to(`user:${userId}`).emit(event, payload);
      return;
    }
    try {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, ...(tenantId ? { tenant_id: tenantId } : {}), ativo: true },
        select: { id: true, tenant_id: true, role: true, ativo: true, pl_sales_only: true },
      });
      if (!user?.ativo || user.id !== userId || (tenantId && tenantId !== user.tenant_id)) return;
      if (isPlSalesOnly({ tenantId: user.tenant_id, role: user.role, plSalesOnly: user.pl_sales_only })) {
        if (kind === 'task') {
          const id = data.id ?? data.taskId;
          if (typeof id !== 'string' || !id) return;
          const task = await this.prisma.task.findFirst({
            where: { id, tenant_id: user.tenant_id, responsavel_id: user.id,
              OR: [{ lead_id: null }, { lead: { tenant_id: user.tenant_id, responsavel_id: user.id } }],
            },
            select: { lead_id: true },
          });
          if (!task || (data.lead_id !== undefined && data.lead_id !== task.lead_id)) return;
        } else {
          // Covers fresh inbound notifications and old rows replayed after a
          // profile flip. Unknown/global destinations are not part of this role.
          const match = typeof data.link === 'string' ? /^\/chat\/([^/]+)$/.exec(data.link) : null;
          if (!match || !LEAD_ID.test(match[1])) return;
          const lead = await this.prisma.lead.findFirst({
            where: { id: match[1], tenant_id: user.tenant_id, responsavel_id: user.id },
            select: { id: true },
          });
          if (!lead) return;
        }
      }
      this.server.to(`user:${userId}`).emit(event, payload);
    } catch {
      this.logger.warn('Restricted user event skipped: ownership lookup failed');
    }
  }
}
