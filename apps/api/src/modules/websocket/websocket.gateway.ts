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

const rawFrontendUrl = process.env['FRONTEND_URL'] ?? '';
const wsOrigins = rawFrontendUrl
  ? rawFrontendUrl.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:3000'];

@WebSocketGateway({
  cors: { origin: wsOrigins, credentials: true },
  transports: ['websocket'],
  pingInterval: 20000,
  pingTimeout: 25000,
})
export class CrmGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(CrmGateway.name);

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token ||
                    client.handshake.headers.authorization?.split(' ')[1];
      if (!token) { client.disconnect(); return; }
      const payload = this.jwtService.verify(token, {
        secret: this.config.get('JWT_SECRET'),
      });
      const tenantId = payload.tenantId ?? payload.tenant_id;
      client.data.userId = payload.sub;
      client.data.tenantId = tenantId;
      client.join(`user:${payload.sub}`);
      if (tenantId) client.join(`tenant:${tenantId}`);
      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub} tenant: ${tenantId})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:lead')
  handleJoinLead(client: Socket, leadId: string) {
    client.join(`lead:${leadId}`);
  }

  @SubscribeMessage('leave:lead')
  handleLeaveLead(client: Socket, leadId: string) {
    client.leave(`lead:${leadId}`);
  }

  private toTenant(tenantId: string | undefined) {
    return tenantId ? this.server.to(`tenant:${tenantId}`) : this.server;
  }

  emitLeadStageChanged(leadId: string, data: unknown, tenantId?: string) {
    this.toTenant(tenantId).emit('lead:stage-changed', { leadId, ...(data as object) });
  }

  emitNewMessage(leadId: string, message: unknown, tenantId?: string) {
    this.logger.log(
      `emitNewMessage → lead:${leadId} tenant:${tenantId ?? '-'}`,
    );
    this.server.to(`lead:${leadId}`).emit('message:new', message);
    this.toTenant(tenantId).emit('lead:new-message', { leadId, message });
  }

  emitMessageStatusUpdate(leadId: string, messageId: string, status: string) {
    this.server.to(`lead:${leadId}`).emit('message:status-updated', { messageId, status });
  }

  /**
   * Emitted when deferred media upload finishes. Frontend patches the message
   * already in cache so the audio/image renders without a refresh.
   */
  emitMessageMediaReady(
    leadId: string,
    payload: { messageId: string; media_url: string; media_mimetype?: string | null },
  ) {
    this.server.to(`lead:${leadId}`).emit('message:media-ready', payload);
  }

  emitInstanceStatusChanged(instanceName: string, status: string, tenantId?: string) {
    this.toTenant(tenantId).emit('instance:status-changed', { instanceName, status });
  }

  emitQrCode(instanceName: string, qrCode: string, tenantId?: string) {
    this.toTenant(tenantId).emit('instance:qr-code', { instanceName, qrCode });
  }

  emitTaskCreated(responsavelId: string, task: unknown) {
    this.server.to(`user:${responsavelId}`).emit('task:created', task);
  }

  emitTaskUpdated(responsavelId: string, task: unknown) {
    this.server.to(`user:${responsavelId}`).emit('task:updated', task);
  }

  emitTaskOverdue(responsavelId: string, payload: { taskId: string; titulo: string; responsavel_id: string }) {
    this.server.to(`user:${responsavelId}`).emit('task:overdue', payload);
  }

  emitLeadUnreadReset(leadId: string, tenantId?: string) {
    this.toTenant(tenantId).emit('lead:unread-reset', { leadId, mensagens_nao_lidas: 0 });
  }

  emitLeadUpdated(leadId: string, data: unknown, tenantId?: string) {
    this.toTenant(tenantId).emit('lead:updated', { leadId, ...(data as object) });
  }
}
