import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';

const WPP_WEBHOOK_EVENTS = {
  url: 'http://crm-backend:3001/api/webhook/wppconnect',
  readMessage: true,
  allUnreadOnStart: false,
  listenAcks: true,
  onPresenceChanged: false,
  onParticipantsChanged: false,
  onReactionMessage: false,
  onPollResponse: false,
  onRevokedMessage: true,
  onLabelUpdated: false,
  onSelfMessage: false,
};

@Injectable()
export class InstancesService {
  private readonly logger = new Logger(InstancesService.name);
  private readonly apiUrl: string;
  private readonly secretKey: string;

  constructor(
    private http: HttpService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiUrl = config.get('WPPCONNECT_URL_INTERNAL', 'http://wppconnect:21465') || 'http://wppconnect:21465';
    this.secretKey = config.get('WPPCONNECT_SECRET', '') || '';
  }

  private async getToken(session: string): Promise<string> {
    const { data } = await firstValueFrom(
      this.http.post(`${this.apiUrl}/${this.secretKey}/generate-token`, { session }),
    );
    return (data as { token: string }).token;
  }

  private async bearerHeaders(session: string) {
    const token = await this.getToken(session);
    return { Authorization: `Bearer ${token}` };
  }

  async findAll() {
    return this.prisma.whatsappInstance.findMany({
      orderBy: { created_at: 'asc' },
    });
  }

  async create(nome: string) {
    const headers = await this.bearerHeaders(nome);

    await firstValueFrom(
      this.http.post(
        `${this.apiUrl}/api/${nome}/start-session`,
        { webhook: WPP_WEBHOOK_EVENTS },
        { headers },
      ),
    ).catch(() => null);

    await this.prisma.whatsappInstance.upsert({
      where: { nome },
      create: { nome, status: 'connecting' },
      update: { status: 'connecting' },
    });

    return { instanceName: nome, status: 'connecting' };
  }

  async getQrCode(nome: string) {
    const headers = await this.bearerHeaders(nome);
    const { data } = await firstValueFrom(
      this.http.get(`${this.apiUrl}/api/${nome}/qrcode-session`, { headers }),
    );
    const d = data as Record<string, unknown>;
    return { base64: d.qrcode ?? d.base64 ?? null };
  }

  async reconnect(nome: string) {
    const headers = await this.bearerHeaders(nome);
    await firstValueFrom(
      this.http.post(`${this.apiUrl}/api/${nome}/logout-session`, {}, { headers }),
    ).catch(() => null);

    await firstValueFrom(
      this.http.post(
        `${this.apiUrl}/api/${nome}/start-session`,
        { webhook: WPP_WEBHOOK_EVENTS },
        { headers },
      ),
    ).catch(() => null);

    return this.getQrCode(nome);
  }

  async checkStatus(nome: string) {
    const headers = await this.bearerHeaders(nome);
    const { data } = await firstValueFrom(
      this.http.get(`${this.apiUrl}/api/${nome}/status-session`, { headers }),
    );
    const d = data as Record<string, unknown>;
    const statusMap: Record<string, string> = {
      CONNECTED: 'open',
      QRCODE: 'connecting',
      DISCONNECTED: 'close',
      DESTROYED: 'close',
      notLogged: 'close',
    };
    const raw = String(d?.status || d?.state || 'DISCONNECTED');
    const status = statusMap[raw] ?? 'disconnected';

    await this.prisma.whatsappInstance.update({
      where: { nome },
      data: { status, ultimo_check: new Date() },
    });
    return data;
  }

  async delete(nome: string) {
    const headers = await this.bearerHeaders(nome).catch(() => null);
    if (headers) {
      await firstValueFrom(
        this.http.post(`${this.apiUrl}/api/${nome}/close-session`, {}, { headers }),
      ).catch(() => null);
    }
    await this.prisma.whatsappInstance.delete({ where: { nome } }).catch(() => null);
  }
}
