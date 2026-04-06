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

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
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
      client.data.userId = payload.sub;
      client.join(`user:${payload.sub}`);
      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub})`);
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

  emitLeadStageChanged(leadId: string, data: unknown) {
    this.server.emit('lead:stage-changed', { leadId, ...data as object });
  }

  emitNewMessage(leadId: string, message: unknown) {
    this.server.to(`lead:${leadId}`).emit('message:new', message);
    this.server.emit('lead:new-message', { leadId, message });
  }

  emitMessageStatusUpdate(leadId: string, messageId: string, status: string) {
    this.server.to(`lead:${leadId}`).emit('message:status-updated', { messageId, status });
  }

  emitInstanceStatusChanged(instanceName: string, status: string) {
    this.server.emit('instance:status-changed', { instanceName, status });
  }

  emitQrCode(instanceName: string, qrCode: string) {
    this.server.emit('instance:qr-code', { instanceName, qrCode });
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
}
